import { describe, it, expect, vi } from "vitest";
import { collectStreamedCompletion } from "./stream.js";

async function* chunks(items: unknown[]) {
  for (const item of items) {
    yield item;
  }
}

function toolChunk(index: number, extra: Record<string, unknown>): unknown {
  return { choices: [{ delta: { tool_calls: [{ index, ...extra }] } }] };
}

describe("collectStreamedCompletion", () => {
  it("passes through non-stream responses", async () => {
    const result = await collectStreamedCompletion({
      choices: [{ message: { content: "hi", tool_calls: [{ id: "t1", type: "function", function: { name: "a.b", arguments: "{}" } }] } }],
    });
    expect(result).toEqual({
      content: "hi",
      toolCalls: [{ id: "t1", type: "function", function: { name: "a.b", arguments: "{}" } }],
      streamed: false,
    });
  });

  it("assembles content and tool calls from stream chunks", async () => {
    const onDelta = vi.fn();
    const result = await collectStreamedCompletion(
      chunks([
        { choices: [{ delta: { content: "你" } }] },
        { choices: [{ delta: { content: "好" } }] },
        toolChunk(0, { id: "call_1", function: { name: "k8s", arguments: '{"ns"' } }),
        toolChunk(0, { function: { arguments: ':"x"}' } }),
        { choices: [{ delta: {} }] },
      ]),
      onDelta,
    );
    expect(result.content).toBe("你好");
    expect(result.streamed).toBe(true);
    expect(result.toolCalls).toEqual([
      { id: "call_1", type: "function", function: { name: "k8s", arguments: '{"ns":"x"}' } },
    ]);
    expect(onDelta).toHaveBeenCalledTimes(2);
  });
});
