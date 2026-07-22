import { describe, it, expect } from "vitest";
import { canonicalize, computeArgsHash } from "./argsHash.js";
import type { SkillName } from "../types.js";

describe("canonicalize", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalize({ b: 2, a: 1 })).toEqual({ a: 1, b: 2 });
    expect(canonicalize({ z: { b: 2, a: 1 }, a: 0 })).toEqual({ a: 0, z: { a: 1, b: 2 } });
  });

  it("preserves array order", () => {
    expect(canonicalize([{ b: 2, a: 1 }, { d: 4, c: 3 }])).toEqual([
      { a: 1, b: 2 },
      { c: 3, d: 4 },
    ]);
  });

  it("leaves primitives unchanged", () => {
    expect(canonicalize(null)).toBe(null);
    expect(canonicalize(42)).toBe(42);
    expect(canonicalize("hello")).toBe("hello");
    expect(canonicalize(true)).toBe(true);
  });
});

describe("computeArgsHash", () => {
  it("returns the same hash for semantically identical args", () => {
    const h1 = computeArgsHash("k8s" as SkillName, "patch_resource_limits", {
      namespace: "default",
      podName: "api-0",
      cpuLimit: "500m",
    });
    const h2 = computeArgsHash("k8s" as SkillName, "patch_resource_limits", {
      cpuLimit: "500m",
      namespace: "default",
      podName: "api-0",
    });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns different hashes when skill differs", () => {
    const h1 = computeArgsHash("k8s" as SkillName, "patch_resource_limits", { podName: "x" });
    const h2 = computeArgsHash("linux" as SkillName, "patch_resource_limits", { podName: "x" });
    expect(h1).not.toBe(h2);
  });

  it("returns different hashes when tool differs", () => {
    const h1 = computeArgsHash("k8s" as SkillName, "patch_resource_limits", { podName: "x" });
    const h2 = computeArgsHash("k8s" as SkillName, "restart_service", { podName: "x" });
    expect(h1).not.toBe(h2);
  });

  it("returns different hashes when args differ", () => {
    const h1 = computeArgsHash("k8s" as SkillName, "patch_resource_limits", { podName: "x" });
    const h2 = computeArgsHash("k8s" as SkillName, "patch_resource_limits", { podName: "y" });
    expect(h1).not.toBe(h2);
  });

  it("handles nested objects consistently", () => {
    const h1 = computeArgsHash("k8s" as SkillName, "patch_resource_limits", {
      labels: { app: "api", env: "prod" },
      spec: { containers: [{ image: "nginx", name: "web" }] },
    });
    const h2 = computeArgsHash("k8s" as SkillName, "patch_resource_limits", {
      spec: { containers: [{ name: "web", image: "nginx" }] },
      labels: { env: "prod", app: "api" },
    });
    expect(h1).toBe(h2);
  });
});
