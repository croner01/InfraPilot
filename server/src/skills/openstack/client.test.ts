import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fromEnv,
  resetAuthCache,
  openstackRequest,
  showServer,
  listHypervisors,
  listNeutronAgents,
  listNovaServices,
  rebootServer,
  OpenStackClientError,
} from "./client.js";

const AUTH_URL = "http://keystone.example.com:5000";
const COMPUTE_URL = "http://nova.example.com:8774/v2.1";
const NETWORK_URL = "http://neutron.example.com:9696";
const PLACEMENT_URL = "http://placement.example.com:8780";

const DEFAULT_CATALOG = [
  {
    type: "compute",
    name: "nova",
    endpoints: [{ interface: "public", region: "RegionOne", url: COMPUTE_URL }],
  },
  {
    type: "network",
    name: "neutron",
    endpoints: [{ interface: "public", region: "RegionOne", url: NETWORK_URL }],
  },
  {
    type: "placement",
    name: "placement",
    endpoints: [{ interface: "public", region: "RegionOne", url: PLACEMENT_URL }],
  },
];

function authResponse(token: string) {
  return {
    ok: true,
    status: 201,
    headers: new Map([["X-Subject-Token", token]]),
    json: async () => ({
      token: {
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        catalog: DEFAULT_CATALOG,
      },
    }),
  };
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("OpenStack client", () => {
  beforeEach(() => {
    resetAuthCache();
    vi.unstubAllGlobals();
    vi.stubEnv("OS_AUTH_URL", AUTH_URL);
    vi.stubEnv("OS_USERNAME", "admin");
    vi.stubEnv("OS_PASSWORD", "secret");
    vi.stubEnv("OS_PROJECT_NAME", "demo");
    vi.stubEnv("OS_PROJECT_DOMAIN_ID", "default");
    vi.stubEnv("OS_USER_DOMAIN_ID", "default");
    vi.stubEnv("OS_REGION_NAME", "RegionOne");
  });

  it("reads config from environment variables", () => {
    const config = fromEnv();
    expect(config.authUrl).toBe(AUTH_URL);
    expect(config.username).toBe("admin");
    expect(config.password).toBe("secret");
    expect(config.projectName).toBe("demo");
  });

  it("throws when required environment variables are missing", () => {
    vi.stubEnv("OS_AUTH_URL", undefined);
    expect(() => fromEnv()).toThrow(OpenStackClientError);
  });

  it("authenticates and caches token", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(authResponse("test-token"))
      .mockResolvedValueOnce(jsonResponse(200, { servers: [] }));

    await openstackRequest("compute", "/servers");
    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[0][0]).toBe(`${AUTH_URL}/v3/auth/tokens`);
    expect(calls[1][1].headers["X-Auth-Token"]).toBe("test-token");
  });

  it("reuses cached token without re-authenticating", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(authResponse("cached-token"))
      .mockResolvedValueOnce(jsonResponse(200, { servers: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { servers: [] }));

    await openstackRequest("compute", "/servers");
    await openstackRequest("compute", "/servers");
    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(3);
    expect(calls[1][1].headers["X-Auth-Token"]).toBe("cached-token");
    expect(calls[2][1].headers["X-Auth-Token"]).toBe("cached-token");
  });

  it("retries authentication on 401", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(authResponse("old-token"))
      .mockResolvedValueOnce(jsonResponse(401, { error: { message: "Unauthorized" } }))
      .mockResolvedValueOnce(authResponse("new-token"))
      .mockResolvedValueOnce(jsonResponse(200, { servers: [] }));

    const result = await openstackRequest("compute", "/servers");
    expect(result.status).toBe(200);
    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(4);
  });

  it("resolves endpoint by region", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 201,
      headers: new Map([["X-Subject-Token", "token"]]),
      json: async () => ({
        token: {
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          catalog: [
            {
              type: "compute",
              name: "nova",
              endpoints: [
                { interface: "public", region: "RegionTwo", url: "http://nova-two.example.com" },
                { interface: "public", region: "RegionOne", url: COMPUTE_URL },
              ],
            },
          ],
        },
      }),
    }).mockResolvedValueOnce(jsonResponse(200, { servers: [] }));

    await openstackRequest("compute", "/servers");
    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[1][0]).toContain("nova.example.com");
  });

  it("showServer normalizes server details", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(authResponse("token"))
      .mockResolvedValueOnce(jsonResponse(200, {
        server: {
          id: "srv-1",
          name: "web-1",
          status: "ERROR",
          tenant_id: "tenant-1",
          flavor: { id: "flavor-1" },
          image: { id: "image-1" },
          "OS-EXT-SRV-ATTR:hypervisor_hostname": "compute-1",
          fault: { message: "NoValidHost", code: 500 },
          addresses: {},
          created: "2024-01-01T00:00:00Z",
          updated: "2024-01-01T00:00:00Z",
        },
      }));

    const result = await showServer("srv-1");
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.status).toBe("ERROR");
    expect(data.hypervisorHostname).toBe("compute-1");
    expect(data.fault.message).toBe("NoValidHost");
  });

  it("listHypervisors returns normalized hypervisor list", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(authResponse("token"))
      .mockResolvedValueOnce(jsonResponse(200, {
        hypervisors: [
          {
            id: 1,
            hypervisor_hostname: "compute-1",
            vcpus: 10,
            vcpus_used: 3,
            memory_mb: 32768,
            memory_mb_used: 8192,
            running_vms: 5,
            state: "up",
            status: "enabled",
          },
        ],
      }));

    const result = await listHypervisors();
    expect(result.success).toBe(true);
    const data = result.data as any[];
    expect(data[0].vcpusUsed).toBe(3);
    expect(data[0].memoryMb).toBe(32768);
  });

  it("listNeutronAgents returns normalized agents", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(authResponse("token"))
      .mockResolvedValueOnce(jsonResponse(200, {
        agents: [
          {
            id: "agent-1",
            agent_type: "DHCP agent",
            host: "network-1",
            availability_zone: "nova",
            alive: true,
            admin_state_up: true,
          },
        ],
      }));

    const result = await listNeutronAgents();
    expect(result.success).toBe(true);
    const data = result.data as any[];
    expect(data[0].agentType).toBe("DHCP agent");
    expect(data[0].alive).toBe(true);
  });

  it("listNovaServices returns normalized services", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(authResponse("token"))
      .mockResolvedValueOnce(jsonResponse(200, {
        services: [
          {
            id: "svc-1",
            binary: "nova-compute",
            host: "compute-1",
            status: "enabled",
            state: "up",
            zone: "nova",
          },
        ],
      }));

    const result = await listNovaServices();
    expect(result.success).toBe(true);
    const data = result.data as any[];
    expect(data[0].binary).toBe("nova-compute");
  });

  it("rebootServer sends POST action", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(authResponse("token"))
      .mockResolvedValueOnce(jsonResponse(202, {}));

    const result = await rebootServer("srv-1", "SOFT");
    expect(result.success).toBe(true);
    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall[0]).toContain("/servers/srv-1/action");
    expect(lastCall[1].method).toBe("POST");
    expect(JSON.parse(lastCall[1].body)).toEqual({ reboot: { type: "SOFT" } });
  });

  it("returns structured error on API failure", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(authResponse("token"))
      .mockResolvedValueOnce(jsonResponse(404, { itemNotFound: { message: "Not found" } }));

    const result = await showServer("missing");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Not found");
  });
});
