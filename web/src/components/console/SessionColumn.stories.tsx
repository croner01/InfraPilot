import type { Meta, StoryObj } from '@storybook/react-vite'
import { SessionColumn } from './SessionColumn.js'
import type { AgentSession } from '../../lib/types.js'

const make = (over: Partial<AgentSession>): AgentSession => ({
  id: 's1',
  title: 'order-api 频繁重启排查',
  status: 'executing',
  createdAt: '2026-09-29T08:30:00Z',
  updatedAt: '2026-09-29T08:32:00Z',
  incidentSummary: 'order-api CrashLoopBackOff',
  plan: [],
  evidence: [],
  pendingToolCalls: [],
  executedToolCalls: [],
  iteration: 2,
  maxIterations: 20,
  activeSkills: ['k8s'],
  ...over,
})

const meta: Meta<typeof SessionColumn> = {
  title: 'console/SessionColumn',
  component: SessionColumn,
}
export default meta
type Story = StoryObj<typeof SessionColumn>

export const Default: Story = {
  args: {
    activeSessions: [make({})],
    closedSessions: [
      make({ id: 's2', title: 'ironic conductor 心跳超时', status: 'concluded', activeSkills: ['openstack'] }),
    ],
    currentId: 's1',
    search: '',
  },
}

export const Collapsed: Story = {
  args: {
    activeSessions: [make({})],
    closedSessions: [],
    currentId: 's1',
    search: '',
    collapsed: true,
  },
}
