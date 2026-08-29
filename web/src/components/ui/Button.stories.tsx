import type { Meta, StoryObj } from '@storybook/react-vite'
import { Button } from './Button.js'

const meta: Meta<typeof Button> = {
  title: 'ui/Button',
  component: Button,
}
export default meta
type Story = StoryObj<typeof Button>

export const Primary: Story = {
  args: { variant: 'primary', children: '新建会话' },
}

export const Secondary: Story = {
  args: { variant: 'secondary', children: '拒绝' },
}

export const Danger: Story = {
  args: { variant: 'danger', children: '批准执行修复' },
}
