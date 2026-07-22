// /tmp/test-mcp.js
process.env.MCP_JWT_SECRET = "change-this-to-a-random-secret-in-production";

(async () => {
  const { grpcMcpClient } = await import("./dist/mcp/grpcClient.js");

  const endpoint = {
    host: "node-1",
    transport: "grpc",
    grpcTarget: "192.168.3.205:12345",
  };

  console.log("[1] Health check...");
  const health = await grpcMcpClient.health(endpoint);
  console.log("health:", health);

  if (!health.ok) {
    console.error("Health failed, stop here.");
    process.exit(1);
  }

  console.log("[2] Call get_cpu_usage...");
  const result = await grpcMcpClient.call(endpoint, {
    tool: "get_cpu_usage",
    args: { host: "node-1", top_n: 3 },
    caller: "local-test",
  });
  console.log("result:", JSON.stringify(result, null, 2));
})();
