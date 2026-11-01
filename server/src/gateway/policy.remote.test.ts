import { describe, it, expect } from "vitest";
import { classifyRisk, renderDiffPreview } from "./policy.js";

describe("remote host approval escalation", () => {
  it("keeps local readonly tools auto-executable", () => {
    const d = classifyRisk("linux", "get_memory_info", { host: "local" });
    expect(d.requiresApproval).toBe(false);
    expect(d.level).toBe("readonly");
  });

  it("escalates ssh-hosted readonly tools to approval", () => {
    const d = classifyRisk("linux", "get_memory_info", { host: "node-1" });
    expect(d.requiresApproval).toBe(true);
    expect(d.level).toBe("medium");
    expect(d.blastRadius).toContain("node-1");
  });

  it("previews the ssh command for remote hosts", () => {
    const preview = renderDiffPreview("linux", "inspect_files", {
      hosts: ["node-1", "node-2"],
      paths: ["/usr/local/bin/helm"],
    });
    expect(preview).toContain("ssh node-1, node-2");
    expect(preview).toContain("stat -c");
  });
});
