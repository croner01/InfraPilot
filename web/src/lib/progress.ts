export interface InvestigationProgress {
  label: string
  step: number
  total: number
  percent: number
}

/** 按会话状态推导调查阶段进度（确定性展示，不做假步数） */
export function progressForStatus(status: string | undefined): InvestigationProgress | null {
  switch (status) {
    case 'intake':
    case 'planning':
      return { label: '正在规划', step: 1, total: 4, percent: 25 }
    case 'executing':
    case 'awaiting_approval':
      return { label: '正在执行诊断', step: 2, total: 4, percent: 50 }
    case 'reflecting':
      return { label: '正在综合分析', step: 3, total: 4, percent: 75 }
    case 'concluded':
    case 'closed':
    case 'remediating':
      return { label: '分析完成', step: 4, total: 4, percent: 100 }
    default:
      return null
  }
}
