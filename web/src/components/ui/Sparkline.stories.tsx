import type { Meta, StoryObj } from '@storybook/react-vite'
import { Sparkline } from './Sparkline.js'

const meta: Meta<typeof Sparkline> = {
  title: 'ui/Sparkline',
  component: Sparkline,
}
export default meta
type Story = StoryObj<typeof Sparkline>

const now = Date.now()

export const Default: Story = {
  args: {
    color: '#dc2626',
    height: 48,
    series: [
      {
        name: 'memory',
        points: Array.from({ length: 12 }, (_, i) => [now - (11 - i) * 60_000, 30 + i * 3 + (i % 3) * 2] as [number, number]),
      },
    ],
  },
}
