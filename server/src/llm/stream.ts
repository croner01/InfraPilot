// ============================================================================
// LLM 流式响应收集器
// 将 OpenAI 兼容的 stream:true 响应聚合成完整 content 与 tool_calls，
// 兼容非流式 mock（测试/降级场景）直接透传。
// ============================================================================

export interface StreamToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ToolCallAcc {
  id?: string;
  name?: string;
  args: string;
}

export interface CollectedCompletion {
  content: string;
  toolCalls: StreamToolCall[];
  streamed: boolean;
}

export async function collectStreamedCompletion(
  completion: unknown,
  onDelta?: (piece: string) => void,
): Promise<CollectedCompletion> {
  const candidate = completion as { [Symbol.asyncIterator]?: unknown } | null;
  if (!candidate || typeof candidate[Symbol.asyncIterator] !== "function") {
    const msg = (completion as any)?.choices?.[0]?.message;
    return {
      content: msg?.content ?? "",
      toolCalls: (msg?.tool_calls ?? []) as StreamToolCall[],
      streamed: false,
    };
  }

  let content = "";
  const acc: Record<number, ToolCallAcc> = {};

  for await (const chunk of completion as AsyncIterable<any>) {
    const delta = chunk?.choices?.[0]?.delta;
    if (delta?.content) {
      content += delta.content;
      onDelta?.(delta.content);
    }
    for (const tc of delta?.tool_calls ?? []) {
      const index = tc?.index ?? 0;
      acc[index] ??= { args: "" };
      if (tc.id) acc[index].id = tc.id;
      if (tc.function?.name) acc[index].name = tc.function.name;
      if (tc.function?.arguments) acc[index].args += tc.function.arguments;
    }
  }

  const toolCalls: StreamToolCall[] = Object.values(acc).map((t) => ({
    id: t.id ?? "",
    type: "function",
    function: { name: t.name ?? "", arguments: t.args },
  }));

  return { content, toolCalls, streamed: true };
}
