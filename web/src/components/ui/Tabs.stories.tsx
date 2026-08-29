import type { Meta, StoryObj } from '@storybook/react-vite'
import { Tabs } from './Tabs.js'

const meta: Meta<typeof Tabs> = {
  title: 'ui/Tabs',
  component: Tabs,
}
export default meta
type Story = StoryObj<typeof Tabs>

export const Default: Story = {
  args: {
    items: [
      { key: 'process', label: '调查过程' },
      { key: 'evidence', label: '证据链', count: 4 },
      { key: 'object', label: '对象上下文' },
    ],
    activeKey: 'evidence',
  },
}
