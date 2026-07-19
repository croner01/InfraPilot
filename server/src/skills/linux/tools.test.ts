import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./remoteExecutor.js", () => ({
  executeOnHost: vi.fn(),
}));

vi.mock("../../mcp/client.js", () => ({
  executeLinuxToolOnHost: vi.fn(),
}));

import { executeOnHost } from "./remoteExecutor.js";
import { executeLinuxToolOnHost } from "../../mcp/client.js";
import { executeLinuxTool } from "./tools.js";

describe("linux tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockLocalRunner(responses: Record<string, any>) {
    const mocked = executeOnHost as ReturnType<typeof vi.fn>;
    mocked.mockImplementation((host: string, command: string, args: string[]) => {
      const key = [command, ...args].join(" ");
      for (const [pattern, resp] of Object.entries(responses)) {
        if (key.includes(pattern)) {
          return Promise.resolve({ success: true, stdout: resp, stderr: "", durationMs: 10 });
        }
      }
      return Promise.resolve({ success: true, stdout: "", stderr: "", durationMs: 10 });
    });
  }

  describe("local execution", () => {
    it("get_cpu_usage executes top pipeline", async () => {
      const mocked = executeOnHost as ReturnType<typeof vi.fn>;
      mocked.mockResolvedValue({ success: true, stdout: "top output", stderr: "", durationMs: 10 });

      const res = await executeLinuxTool("get_cpu_usage", { host: "local" });
      expect(res.success).toBe(true);
      expect(res.stdout).toBe("top output");
      expect(mocked).toHaveBeenCalledWith(
        "local",
        "sh",
        ["-c", "top -b -n 1 | head -n 15"],
        expect.objectContaining({ timeoutMs: 10000 })
      );
    });

    it("get_memory_info aggregates free and dmesg output", async () => {
      mockLocalRunner({
        "free -m": "total: 1000\nused: 500",
        "dmesg": "oom-killer invoked",
      });

      const res = await executeLinuxTool("get_memory_info", { host: "local" });
      expect(res.success).toBe(true);
      expect(res.data).toMatchObject({
        free_output: "total: 1000\nused: 500",
        oom_history: "oom-killer invoked",
      });
    });

    it("get_memory_info includes process detail when pid provided", async () => {
      mockLocalRunner({
        "free -m": "total: 1000",
        "dmesg": "",
        "cat /proc/1234/status": "VmRSS:   2048 kB\nVmSize:  4096 kB",
      });

      const res = await executeLinuxTool("get_memory_info", { host: "local", pid: 1234 });
      expect(res.success).toBe(true);
      expect((res.data as any).process_detail).toMatchObject({
        pid: 1234,
        rss_mb: 2,
        vm_size_mb: 4,
      });
    });

    it("get_disk_usage executes df -h", async () => {
      const mocked = executeOnHost as ReturnType<typeof vi.fn>;
      mocked.mockResolvedValue({ success: true, stdout: "Filesystem size used", stderr: "", durationMs: 10 });

      const res = await executeLinuxTool("get_disk_usage", { host: "local" });
      expect(res.success).toBe(true);
      expect(res.stdout).toContain("Filesystem");
      expect(mocked).toHaveBeenCalledWith("local", "df", ["-h"], expect.any(Object));
    });

    it("get_process_info sanitizes pattern and uses grep pipeline", async () => {
      const mocked = executeOnHost as ReturnType<typeof vi.fn>;
      mocked.mockResolvedValue({ success: true, stdout: "1234 10M 0.5 100 orderApiWorker", stderr: "", durationMs: 10 });

      const res = await executeLinuxTool("get_process_info", { host: "local", name_pattern: "orderApiWorker;rm -rf /" });
      expect(res.success).toBe(true);
      expect(mocked).toHaveBeenCalledWith(
        "local",
        "sh",
        ["-c", "ps -eo pid,rss,pcpu,etimes,cmd | grep -i 'orderApiWorkerrm-rf' | grep -v grep || true"],
        expect.any(Object)
      );
    });

    it("tail_recent_dmesg_or_syslog executes dmesg tail", async () => {
      const mocked = executeOnHost as ReturnType<typeof vi.fn>;
      mocked.mockResolvedValue({ success: true, stdout: "dmesg line", stderr: "", durationMs: 10 });

      const res = await executeLinuxTool("tail_recent_dmesg_or_syslog", { host: "local" });
      expect(res.success).toBe(true);
      expect(res.stdout).toContain("dmesg line");
    });

    it("get_network_stats executes ss -s", async () => {
      const mocked = executeOnHost as ReturnType<typeof vi.fn>;
      mocked.mockResolvedValue({ success: true, stdout: "TCP: 100", stderr: "", durationMs: 10 });

      const res = await executeLinuxTool("get_network_stats", { host: "local" });
      expect(res.success).toBe(true);
      expect(res.stdout).toContain("TCP");
      expect(mocked).toHaveBeenCalledWith("local", "ss", ["-s"], expect.any(Object));
    });
  });

  describe("remote execution", () => {
    it("get_cpu_usage routes to MCP Client Router", async () => {
      const mocked = executeLinuxToolOnHost as ReturnType<typeof vi.fn>;
      mocked.mockResolvedValue({ success: true, stdout: "remote top output", durationMs: 20 });

      const res = await executeLinuxTool("get_cpu_usage", { host: "node-1" });
      expect(res.success).toBe(true);
      expect(res.stdout).toBe("remote top output");
      expect(mocked).toHaveBeenCalledWith(
        expect.objectContaining({
          tool: "get_cpu_usage",
          args: { host: "node-1" },
          caller: "linux-skill",
          timeoutMs: 10000,
        })
      );
    });

    it("get_network_stats routes to MCP Client Router", async () => {
      const mocked = executeLinuxToolOnHost as ReturnType<typeof vi.fn>;
      mocked.mockResolvedValue({ success: true, data: { total_connections: 100 }, durationMs: 20 });

      const res = await executeLinuxTool("get_network_stats", { host: "node-1", iface: "eth0" });
      expect(res.success).toBe(true);
      expect(mocked).toHaveBeenCalledWith(
        expect.objectContaining({
          tool: "get_network_stats",
          args: { host: "node-1", iface: "eth0" },
          timeoutMs: 10000,
        })
      );
    });

    it("restart_service uses longer timeout", async () => {
      const mocked = executeLinuxToolOnHost as ReturnType<typeof vi.fn>;
      mocked.mockResolvedValue({ success: true, stdout: "ok", durationMs: 200 });

      const res = await executeLinuxTool("restart_service", { host: "node-1", service_name: "nginx" });
      expect(res.success).toBe(true);
      expect(mocked).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 30000 }));
    });

    it("kill_process uses longer timeout", async () => {
      const mocked = executeLinuxToolOnHost as ReturnType<typeof vi.fn>;
      mocked.mockResolvedValue({ success: true, stdout: "ok", durationMs: 200 });

      const res = await executeLinuxTool("kill_process", { host: "node-1", pid: 1234, signal: "SIGTERM" });
      expect(res.success).toBe(true);
      expect(mocked).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 30000 }));
    });

    it("catches MCP router exceptions and returns error result", async () => {
      const mocked = executeLinuxToolOnHost as ReturnType<typeof vi.fn>;
      mocked.mockRejectedValue(new Error("boom"));
      const res = await executeLinuxTool("get_cpu_usage", { host: "node-1" });
      expect(res.success).toBe(false);
      expect(res.error).toContain("boom");
    });
  });

  it("returns error for unknown local tool", async () => {
    const res = await executeLinuxTool("unknown_tool", { host: "local" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("本地不支持的linux工具");
  });

  it("catches local execution exceptions and returns error result", async () => {
    const mocked = executeOnHost as ReturnType<typeof vi.fn>;
    mocked.mockRejectedValue(new Error("boom"));
    const res = await executeLinuxTool("get_cpu_usage", { host: "local" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("boom");
  });
});
