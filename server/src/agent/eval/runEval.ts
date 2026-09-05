// 离线评测运行器：对每个 cases/*.json 创建真实 Agent 会话并评估结论
// 用法: tsx src/agent/eval/runEval.ts [base-url]   (默认 http://localhost:8787)
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateCase } from "./evaluate.js";
import type { EvalCase, EvalContext } from "./types.js";

const base = process.argv[2] ?? "http://localhost:8787";
const casesDir = join(import.meta.dirname, "cases");

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${base}/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${base}/api${path}`);
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

async function runCase(evalCase: EvalCase): Promise<boolean> {
  const session = await post<{ id: string }>("/sessions", { title: `eval:${evalCase.id}` });
  await fetch(`${base}/api/sessions/${session.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: evalCase.message }),
  });

  const deadline = Date.now() + 180_000;
  let data: any;
  for (;;) {
    data = await get(`/sessions/${session.id}`);
    if (["concluded", "closed"].includes(data.status) || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 5000));
  }

  const events = await get<Array<{ type: string; payload: any }>>(`/sessions/${session.id}/events`);
  const ctx: EvalContext = {
    toolsUsed: Array.from(
      new Map(
        events
          .filter((e) => e.type === "tool_call_start")
          .map((e) => [`${e.payload?.skill}.${e.payload?.tool}`, { skill: e.payload?.skill, tool: e.payload?.tool }]),
      ).values(),
    ),
    rootCauseSummary: data?.rootCause?.summary ?? "",
    hypotheses: (data?.hypotheses ?? []).map((h: any) => ({ statement: h.statement, status: h.status })),
  };
  const result = evaluateCase(evalCase, ctx);

  console.log(`[${result.passedAll ? "PASS" : "FAIL"}] ${evalCase.id} (${data?.status})`);
  for (const check of result.checks) {
    console.log(`   ${check.passed ? "✓" : "✗"} ${JSON.stringify(check.check)}`);
  }
  return result.passedAll;
}

async function main() {
  const files = readdirSync(casesDir).filter((f) => f.endsWith(".json"));
  const cases = files.map((f) => JSON.parse(readFileSync(join(casesDir, f), "utf-8")) as EvalCase);
  console.log(`运行 ${cases.length} 个评测 case, base=${base}`);
  const results: boolean[] = [];
  for (const evalCase of cases) {
    try {
      results.push(await runCase(evalCase));
    } catch (err) {
      console.log(`[ERROR] ${evalCase.id}: ${err instanceof Error ? err.message : String(err)}`);
      results.push(false);
    }
  }
  const passed = results.filter(Boolean).length;
  console.log(`\n结果: ${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
}

void main();
