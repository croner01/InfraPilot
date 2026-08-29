import type { Meta, StoryObj } from '@storybook/react-vite'
import { Markdown } from './Markdown.js'

const meta: Meta<typeof Markdown> = {
  title: 'ui/Markdown',
  component: Markdown,
}
export default meta
type Story = StoryObj<typeof Markdown>

export const Default: Story = {
  args: {
    children: '### 初步判断\n\n- Pod 状态 **CrashLoopBackOff**\n- 退出码 `137 (OOMKilled)`\n\n| 服务 | 状态 |\n| --- | --- |\n| order-api | 异常 |\n\n```\nkubectl get pods\n```',
  },
}
