import type { Meta, StoryObj } from '@storybook/react-vite'
import { SessionList } from './SessionList.js'

const meta: Meta<typeof SessionList> = {
  title: 'console/SessionList',
  component: SessionList,
}
export default meta
type Story = StoryObj<typeof SessionList>

const makeSession = (id: string, title: string, status: string) => ({
  id,
  title,
  status,
  createdAt: '2026-08-25T10:00:00Z',
  updatedAt: '2026-08-25T10:30:00Z',
  incidentSummary: '',
  plan: [],
  evidence: [],
  pendingToolCalls: [],
  executedToolCalls: [],
  iteration: 3,
  maxIterations: 20,
})

export const Default: Story = {
  args: {
    activeSessions: [makeSession('s1', 'order-api 内存异常排查', 'concluded')],
    closedSessions: [makeSession('s2', 'node-08 磁盘排查', 'closed')],
    currentId: 's1',
    search: '',
  },
}
