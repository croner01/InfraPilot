import type { Meta, StoryObj } from '@storybook/react-vite'
import { MessageUser } from './MessageUser.js'

const meta: Meta<typeof MessageUser> = {
  title: 'conversation/MessageUser',
  component: MessageUser,
}
export default meta
type Story = StoryObj<typeof MessageUser>

export const Default: Story = {
  args: { content: 'order-api Pod 一直在重启，帮我查下原因' },
}
