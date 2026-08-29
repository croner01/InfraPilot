import type { Meta, StoryObj } from '@storybook/react-vite'
import { ConclusionCard } from './ConclusionCard.js'

const meta: Meta<typeof ConclusionCard> = {
  title: 'conclusion/ConclusionCard',
  component: ConclusionCard,
}
export default meta
type Story = StoryObj<typeof ConclusionCard>

export const Default: Story = {
  args: {
    rootCause: {
      summary: 'order-api 容器内存 limit（256Mi）低于高峰流量需求，触发 OOMKilled 并持续重启',
      confidence: 0.87,
      evidenceChain: [
        { evidenceId: 'ev1', role: 'primary' },
        { evidenceId: 'ev2', role: 'supporting' },
        { evidenceId: 'ev3', role: 'supporting' },
      ],
      alternativeHypotheses: ['节点资源不足（已排除）'],
    },
    remediation: {
      summary: '调整内存 limit',
      steps: [
        { description: '将内存 limit 从 256Mi 调整到 512Mi', skill: 'k8s', tool: 'patch_deployment', risk: 'medium', rollback: '改回 256Mi' },
        { description: '观察 15 分钟确认重启归零', skill: 'k8s', tool: 'get_pods', risk: 'low' },
      ],
    },
  },
}
