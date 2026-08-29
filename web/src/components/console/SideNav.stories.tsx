import type { Meta, StoryObj } from '@storybook/react-vite'
import { SideNav } from './SideNav.js'

const meta: Meta<typeof SideNav> = {
  title: 'console/SideNav',
  component: SideNav,
}
export default meta
type Story = StoryObj<typeof SideNav>

export const Default: Story = {
  args: {
    activeView: 'sessions',
    alertCount: 3,
    activeSessions: [],
    closedSessions: [],
    currentId: null,
    search: '',
  },
}
