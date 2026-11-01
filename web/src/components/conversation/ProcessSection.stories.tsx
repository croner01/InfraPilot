import type { Meta, StoryObj } from '@storybook/react-vite'
import { EvidenceChips, ToolCallCard, ToolGroupCard, ThinkCard } from './ProcessSection.js'

const meta: Meta<typeof ToolCallCard> = {
  title: 'conversation/ProcessSection',
  component: ToolCallCard,
}
export default meta
type Story = StoryObj<typeof ToolCallCard>

export const Default: Story = {
  render: () => (
    <div style={{ padding: 24, maxWidth: 760 }}>
      <ThinkCard text="先确认 Pod 状态与重启次数，再拉取日志与内存指标交叉验证。" defaultOpen />
      <ToolCallCard
        item={{
          key: 't1',
          icon: 'tool',
          status: 'ok',
          title: 'k8s.get_pod_status()',
          riskLevel: 'readonly',
          durationMs: 240,
          args: { name: 'order-api-7f9d8b6c-x2kq', namespace: 'default' },
          resultText: '{"phase":"Running","restarts":6}',
        }}
      />
      <ToolGroupCard
        group={{
          key: 'g1',
          isGroup: true,
          label: '批量采集',
          items: [
            { key: 't2', icon: 'tool', status: 'ok', title: 'elk.search_logs()', durationMs: 512 },
            { key: 't3', icon: 'tool', status: 'ok', title: 'prom.range_query()', durationMs: 178 },
          ],
        }}
      />
      <EvidenceChips items={[{ id: 'e1', label: 'OOMKilled · exit 137' }, { id: 'e2', label: 'heap 91% 线性增长' }]} />
    </div>
  ),
}
