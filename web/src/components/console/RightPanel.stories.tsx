import type { Meta, StoryObj } from '@storybook/react-vite'
import { RightPanel } from './RightPanel.js'

const meta: Meta<typeof RightPanel> = {
  title: 'console/RightPanel',
  component: RightPanel,
}
export default meta
type Story = StoryObj<typeof RightPanel>

const note = (text: string) => <p style={{ color: 'var(--text-2)', fontSize: 12 }}>{text}</p>

export const Default: Story = {
  args: {
    track: note('执行跟踪：一行执行进展 + 里程碑 + 思考记录（实时流落在 live 条目上）'),
    evidence: note('证据链'),
    audit: note('审计记录'),
    plan: note('诊断计划 + 假设'),
    remediation: note('修复方案'),
    artifacts: note('会话产物'),
    counts: { evidence: 3, audit: 5, plan: 4 },
  },
}
