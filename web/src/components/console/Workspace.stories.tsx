import type { Meta, StoryObj } from '@storybook/react-vite'
import { Workspace } from './Workspace.js'

const meta: Meta<typeof Workspace> = {
  title: 'console/Workspace',
  component: Workspace,
}
export default meta
type Story = StoryObj<typeof Workspace>

export const Default: Story = {
  render: () => (
    <Workspace>
      <div style={{ padding: 24 }}>工作台内容区</div>
    </Workspace>
  ),
}
