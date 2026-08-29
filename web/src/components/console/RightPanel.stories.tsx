import type { Meta, StoryObj } from '@storybook/react-vite'
import { RightPanel } from './RightPanel.js'

const meta: Meta<typeof RightPanel> = {
  title: 'console/RightPanel',
  component: RightPanel,
}
export default meta
type Story = StoryObj<typeof RightPanel>

export const Default: Story = {
  args: {
    process: <p style={{ color: 'var(--text-2)' }}>调查过程（M3/M7 接入）</p>,
    evidence: <p style={{ color: 'var(--text-2)' }}>证据链（M3 接入）</p>,
    object: <p style={{ color: 'var(--text-2)' }}>对象上下文（M5/M6 接入）</p>,
  },
}
