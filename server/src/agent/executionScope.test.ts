import { describe, it, expect, afterEach } from "vitest";
import { getExecutionScopeNote } from "./executionScope.js";

describe("getExecutionScopeNote", () => {
  afterEach(() => {
    delete process.env.KUBERNETES_SERVICE_HOST;
  });

  it("returns in-cluster note when running inside k8s", () => {
    process.env.KUBERNETES_SERVICE_HOST = "10.43.0.1";
    const note = getExecutionScopeNote();
    expect(note).toContain("Kubernetes Pod 内");
    expect(note).toContain("k8s.top_pods");
  });

  it("returns host note when running on host", () => {
    const note = getExecutionScopeNote();
    expect(note).toContain("宿主机");
  });
});
