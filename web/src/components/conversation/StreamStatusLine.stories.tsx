import type { Meta, StoryObj } from '@storybook/react-vite'
import { StreamStatusLine } from './StreamStatusLine.js'

const meta: Meta<typeof StreamStatusLine> = {
  title: 'conversation/StreamStatusLine',
  component: StreamStatusLine,
}
export default meta
type Story = StoryObj<typeof StreamStatusLine>

export const Default: Story = {
  args: { text: '正在执行 k8s.describe_pod()…' },
}
