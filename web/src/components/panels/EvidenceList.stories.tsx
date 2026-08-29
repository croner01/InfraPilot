import type { Meta, StoryObj } from '@storybook/react-vite'
import { EvidenceList } from './EvidenceList.js'

const meta: Meta<typeof EvidenceList> = {
  title: 'panels/EvidenceList',
  component: EvidenceList,
}
export default meta
type Story = StoryObj<typeof EvidenceList>

export const Default: Story = {
  args: {
    evidence: [
      { id: 'ev1', sourceSkill: 'k8s', type: 'k8s_event', content: { exitCode: 137 }, confidence: 0.92, collectedAt: '2026-08-25T10:38:00Z', summary: 'Pod 事件：OOMKilled，退出码 137' },
      { id: 'ev2', sourceSkill: 'elk', type: 'log_cluster', content: 'error log', confidence: 0.84, collectedAt: '2026-08-25T10:35:00Z', summary: '错误日志聚类：2 类与内存相关' },
    ],
    highlightId: 'ev1',
  },
}
