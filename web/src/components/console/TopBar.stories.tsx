import type { Meta, StoryObj } from '@storybook/react-vite'
import { TopBar } from './TopBar.js'

const meta: Meta<typeof TopBar> = {
  title: 'console/TopBar',
  component: TopBar,
}
export default meta
type Story = StoryObj<typeof TopBar>

export const Default: Story = {
  args: { connected: true, pendingApprovals: 2, activeAlerts: 3 },
}
