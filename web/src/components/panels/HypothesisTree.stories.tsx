import type { Meta, StoryObj } from '@storybook/react-vite'
import { HypothesisTree } from './HypothesisTree.js'

const meta: Meta<typeof HypothesisTree> = {
  title: 'panels/HypothesisTree',
  component: HypothesisTree,
}
export default meta
type Story = StoryObj<typeof HypothesisTree>

export const Default: Story = {
  args: {
    hypotheses: [
      { id: 'h1', statement: '内存 limit 256Mi 过低，高峰流量触发 OOMKilled', status: 'confirmed', evidenceIds: ['ev1', 'ev2'], toolCallIds: [], updatedAt: '2026-08-25T10:30:00Z' },
      { id: 'h2', statement: '节点 node-08 资源不足导致驱逐', status: 'ruled_out', evidenceIds: ['ev3'], toolCallIds: [], updatedAt: '2026-08-25T10:31:00Z' },
      { id: 'h3', statement: '镜像拉取失败或探针配置错误', status: 'active', evidenceIds: [], toolCallIds: [], updatedAt: '2026-08-25T10:29:00Z' },
    ],
  },
}
