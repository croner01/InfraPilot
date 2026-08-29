import type { Meta, StoryObj } from '@storybook/react-vite'
import { ProcessSection } from './ProcessSection.js'

const meta: Meta<typeof ProcessSection> = {
  title: 'conversation/ProcessSection',
  component: ProcessSection,
}
export default meta
type Story = StoryObj<typeof ProcessSection>

export const Default: Story = {
  args: {
    items: [
      { key: 't1', icon: 'tool', status: 'running', title: 'k8s.describe_pod()' },
      { key: 't2', icon: 'result', status: 'ok', title: 'elk.search_logs(service=order-api)' },
      { key: 'e1', icon: 'evidence', title: '新增证据', detail: 'Pod 事件：OOMKilled，退出码 137' },
    ],
  },
}
