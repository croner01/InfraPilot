import { describe, it, expect } from "vitest";
import { parseCpu, parseMemory } from "./client.js";

describe("parseCpu", () => {
  it("parses millicores and whole cores", () => {
    expect(parseCpu("38m")).toBeCloseTo(0.038);
    expect(parseCpu("500m")).toBeCloseTo(0.5);
    expect(parseCpu("2")).toBe(2);
    expect(parseCpu(undefined)).toBeUndefined();
  });
});

describe("parseMemory", () => {
  it("parses Ki/Mi/Gi suffixes", () => {
    expect(parseMemory("512Ki")).toBe(512 * 1024);
    expect(parseMemory("4095Mi")).toBe(4095 * 1024 * 1024);
    expect(parseMemory("4Gi")).toBe(4 * 1024 * 1024 * 1024);
    expect(parseMemory("1048576")).toBe(1048576);
    expect(parseMemory(undefined)).toBeUndefined();
  });
});
