export interface InvestigationProgress {
  /** 当前阶段标题（与 TRACK_STEPS 同源，保证进度线与里程碑一致） */
  label: string
  /** 当前阶段序号，从 1 开始 */
  step: number
  /** 阶段总数 */
  total: number
  /** 进度百分比（0-100） */
  percent: number
  /** 阶段键，用于在 ExecutionTrackPanel 中高亮对应里程碑 */
  key: TrackStepKey
}

export type TrackStepKey = 'intake' | 'collect' | 'remediate' | 'archive'

export interface TrackStep {
  key: TrackStepKey
  label: string
  note: string
}

/**
 * 执行跟踪步骤模型（与原型 agent-session-cortex.html 右栏「执行跟踪」一致，共 4 步）。
 * 进度线与里程碑共用此模型，避免出现「第 N/M 步」与步骤列表对不上。
 */
export const TRACK_STEPS: TrackStep[] = [
  { key: 'intake', label: '现象确认', note: '接收问题描述，确认现象与影响范围' },
  { key: 'collect', label: '证据采集', note: '调用技能采集日志 / 指标 / 拓扑证据' },
  { key: 'remediate', label: '修复执行', note: '变更操作经审批网关执行并回读验证' },
  { key: 'archive', label: '验证与归档', note: '综合根因分析并沉淀结论至知识库' },
]

/** 会话状态 → 阶段键 + 百分比（确定性展示，不做假步数） */
const PHASE_BY_STATUS: Record<string, { key: TrackStepKey; percent: number }> = {
  intake: { key: 'intake', percent: 25 },
  planning: { key: 'intake', percent: 25 },
  executing: { key: 'collect', percent: 50 },
  awaiting_approval: { key: 'remediate', percent: 75 },
  remediating: { key: 'remediate', percent: 75 },
  reflecting: { key: 'archive', percent: 90 },
  concluded: { key: 'archive', percent: 100 },
  closed: { key: 'archive', percent: 100 },
}

/** 各阶段对应的「推进事件」（与 ExecutionTrackPanel 的里程碑判定同源） */
const STEP_EVENT_TYPES: Record<TrackStepKey, string[]> = {
  intake: ['user_message'],
  collect: ['tool_call_start', 'tool_call_result', 'evidence_added'],
  remediate: ['approval_request', 'approval_decision', 'remediation_plan'],
  archive: ['rca_conclusion', 'done'],
}

/** 阶段基准百分比（会话状态未给出更细取值时使用） */
const PERCENT_BY_KEY: Record<TrackStepKey, number> = {
  intake: 25,
  collect: 50,
  remediate: 75,
  archive: 100,
}

/**
 * 由「事件流 + 会话状态」推导执行进度，取两者中更靠后的阶段。
 *
 * 会话状态由后端在阶段跃迁时推送，存在一轮刷新延迟；事件流则随 WebSocket
 * 实时到达。两者取最大，可让对话区进度线立即跟上最新进展，同时在状态回退
 * （如审批通过后回到 executing）时也不会让进度线倒退。
 */
export function progressFromEvents(
  events: Array<{ type: string }>,
  status: string | undefined,
): InvestigationProgress | null {
  const byStatus = progressForStatus(status)
  let index = byStatus ? TRACK_STEPS.findIndex((s) => s.key === byStatus.key) : -1
  for (let i = TRACK_STEPS.length - 1; i > index; i -= 1) {
    const types = STEP_EVENT_TYPES[TRACK_STEPS[i].key]
    if (events.some((event) => types.includes(event.type))) {
      index = i
      break
    }
  }
  if (index < 0) return null
  const key = TRACK_STEPS[index].key
  return {
    label: TRACK_STEPS[index].label,
    step: index + 1,
    total: TRACK_STEPS.length,
    // 状态侧给了更细的百分比（如 reflecting=90%）且阶段一致时沿用
    percent: byStatus && byStatus.key === key ? byStatus.percent : PERCENT_BY_KEY[key],
    key,
  }
}

/** 按会话状态推导执行阶段进度（与里程碑同源） */
export function progressForStatus(status: string | undefined): InvestigationProgress | null {
  const phase = status ? PHASE_BY_STATUS[status] : undefined
  if (!phase) return null
  const index = TRACK_STEPS.findIndex((s) => s.key === phase.key)
  if (index < 0) return null
  return {
    label: TRACK_STEPS[index].label,
    step: index + 1,
    total: TRACK_STEPS.length,
    percent: phase.percent,
    key: phase.key,
  }
}
