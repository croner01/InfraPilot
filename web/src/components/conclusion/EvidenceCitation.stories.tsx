import type { Meta, StoryObj } from '@storybook/react-vite'
import { EvidenceCitation } from './EvidenceCitation.js'

const meta: Meta<typeof EvidenceCitation> = {
  title: 'conclusion/EvidenceCitation',
  component: EvidenceCitation,
}
export default meta
type Story = StoryObj<typeof EvidenceCitation>

export const Default: Story = {
  args: { label: '证据#1 · 主要' },
}
