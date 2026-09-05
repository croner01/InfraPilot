import { describe, it, expect } from "vitest";
import { countBy, capSamples } from "./summary.js";

describe("countBy", () => {
  it("counts values preserving insertion order", () => {
    expect(countBy(["Running", "Evicted", "Running", "Error"])).toEqual({ Running: 2, Evicted: 1, Error: 1 });
  });
});

describe("capSamples", () => {
  it("caps and reports truncation", () => {
    const input = [1, 2, 3, 4, 5];
    const { samples, truncated } = capSamples(input, 3);
    expect(samples).toEqual([1, 2, 3]);
    expect(truncated).toBe(true);
  });

  it("does not truncate small lists", () => {
    const { truncated } = capSamples([1, 2], 3);
    expect(truncated).toBe(false);
  });
});
