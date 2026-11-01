import type { TimelineEvent } from './types.js'

/**
 * 合并「历史事件（REST 拉取）」与「实时事件（WebSocket 推送）」。
 *
 * 打开会话时历史拉取是异步的，期间 WebSocket 可能已经推来新事件；若直接用
 * `setEvents(history)` 覆盖，这些实时事件会丢失，表现为对话框停在旧进度。
 * 这里按 id 去重，并把真正的增量按到达顺序追加在历史之后。
 */
export function mergeTimeline(
  history: TimelineEvent[],
  live: TimelineEvent[],
  sessionId: string,
): TimelineEvent[] {
  const seen = new Set(history.map((event) => event.id))
  const extra = live.filter((event) => event.sessionId === sessionId && !seen.has(event.id))
  return extra.length === 0 ? history : [...history, ...extra]
}
