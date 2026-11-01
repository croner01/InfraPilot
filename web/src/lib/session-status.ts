import type { SessionStatus } from './types.js'

/** 会话状态中文标签（侧边会话列表与会话顶栏共用） */
export const sessionStatusText: Record<SessionStatus, string> = {
  intake: '接收中',
  planning: '分析规划',
  executing: '执行中',
  awaiting_approval: '等待审批',
  reflecting: '反思中',
  concluded: '已得出结论',
  remediating: '修复中',
  closed: '已关闭',
}

/** 会话状态配色修饰类（配合 .ui-status / .session-bar__status 使用） */
export const sessionStatusClass: Record<SessionStatus, string> = {
  intake: 'status--intake',
  planning: 'status--planning',
  executing: 'status--executing',
  awaiting_approval: 'status--warning',
  reflecting: 'status--planning',
  concluded: 'status--success',
  remediating: 'status--executing',
  closed: 'status--closed',
}

/** 执行中的会话状态（列表项显示脉冲圆点、顶栏显示呼吸点） */
export const RUNNING_SESSION_STATUSES = new Set<SessionStatus>([
  'intake',
  'planning',
  'executing',
  'awaiting_approval',
  'reflecting',
  'remediating',
])
