// ============================================================================
// Linux Skill — 本地命令执行器
//
// 封装 node:child_process.execFile,用于在当前主机执行只读诊断命令。
// 被 remoteExecutor.ts 在 host="local" 时调用。
// ============================================================================

import { execFile } from "node:child_process";

export function run(
  cmd: string,
  args: string[],
  timeoutMs = 8000
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout?.toString() ?? "",
        stderr: stderr?.toString() ?? "",
        code: (err as any)?.code ?? 0,
      });
    });
  });
}
