import type { Meta, StoryObj } from '@storybook/react-vite'
import { CodeBlock } from './CodeBlock.js'

const meta: Meta<typeof CodeBlock> = {
  title: 'ui/CodeBlock',
  component: CodeBlock,
}
export default meta
type Story = StoryObj<typeof CodeBlock>

export const Default: Story = {
  args: {
    language: 'bash',
    code: 'kubectl describe pod order-api-7f9c6d4b8c-x2j8l\n# 输出已截断\nLast State: OOMKilled (exit code 137)',
  },
}
