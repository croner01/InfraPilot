// ============================================================================
// Linux Skill — 本地/远程命令执行路由器
//
// 根据 host 参数决定执行位置:
// - host === "local" 或 undefined: 在当前 sandbox/后端主机本地执行
// - 其他 host: 通过 Command Gateway 层的 SSH Proxy 到目标远程主机执行
//
// 工具层只需要调用 execute(host, command, args),无需关心底层是本地 exec 还是 SSH。
// 这样 Agent/Prompt 完全不用改动,host 参数自然从 "local" 扩展到任意注册主机。
// ============================================================================

import { executeRemoteCommand } from "../../gateway/sshProxy.js";
import { run } from "./localRunner.js";
import { redact } from "../../gateway/redact.js";

export interface ExecuteResult {
  success: boolean;
  stdout?: string;
  stderr?: string;
  data?: Record<string, unknown>;
  error?: string;
  durationMs: number;
}

export async function executeOnHost(
  host: string,
  command: string,
  args: string[],
  options?: { timeoutMs?: number; caller?: string }
): Promise<ExecuteResult> {
  if (!host || host === "local") {
    const start = Date.now();
    try {
      const { stdout, stderr, code } = await run(command, args, options?.timeoutMs);
      return {
        success: code === 0,
        stdout: redact(stdout),
        stderr: redact(stderr),
        durationMs: Date.now() - start,
        error: code !== 0 ? `本地命令退出码非 0: ${code}` : undefined,
      };
    } catch (e: any) {
      return {
        success: false,
        stdout: "",
        stderr: "",
        durationMs: Date.now() - start,
        error: `本地执行失败: ${e?.message ?? String(e)}`,
      };
    }
  }

  // 当 Linux Skill 使用 "sh -c '<pipeline>'" 形式执行复杂诊断命令时,
  // 把内层命令作为受信任的 cmdLine 传给 SSH Proxy,避免 shell 元字符被误拦截。
  const isShWrapper = command === "sh" && args.length === 2 && args[0] === "-c";
  const remote = await executeRemoteCommand({
    host,
    command: isShWrapper ? command : command,
    args: isShWrapper ? args : args,
    cmdLine: isShWrapper ? args[1] : undefined,
    caller: options?.caller ?? "linux-skill",
    timeoutMs: options?.timeoutMs,
  });

  return {
    success: remote.success,
    stdout: remote.stdout,
    stderr: remote.stderr,
    durationMs: remote.durationMs,
    error: remote.error,
  };
}
