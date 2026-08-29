import type { Meta, StoryObj } from '@storybook/react-vite'
import { Badge } from './Badge.js'

const meta: Meta<typeof Badge> = {
  title: 'ui/Badge',
  component: Badge,
}
export default meta
type Story = StoryObj<typeof Badge>

export const Danger: Story = {
  args: { label: 'P0 严重', tone: 'danger' },
}

export const Accent: Story = {
  args: { label: '置信度 87%', tone: 'accent' },
}
