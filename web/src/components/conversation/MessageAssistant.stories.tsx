import type { Meta, StoryObj } from '@storybook/react-vite'
import { MessageAssistant } from './MessageAssistant.js'

const meta: Meta<typeof MessageAssistant> = {
  title: 'conversation/MessageAssistant',
  component: MessageAssistant,
}
export default meta
type Story = StoryObj<typeof MessageAssistant>

export const Default: Story = {
  args: {
    content: '已定位到 `order-service/order-api` 的重启根因。\n\n### 初步判断\n\n- Pod 状态 **CrashLoopBackOff**，重启 14 次\n- 退出码 `137 (OOMKilled)`\n\n| 服务 | 状态 |\n| --- | --- |\n| order-api | 异常 |',
  },
}
