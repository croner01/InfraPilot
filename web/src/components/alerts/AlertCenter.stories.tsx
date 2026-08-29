import type { Meta, StoryObj } from '@storybook/react-vite'
import { AlertCenter } from './AlertCenter.js'

const meta: Meta<typeof AlertCenter> = {
  title: 'alerts/AlertCenter',
  component: AlertCenter,
}
export default meta
type Story = StoryObj<typeof AlertCenter>

export const Default: Story = {
  args: { onInvestigate: (id: string) => console.log('investigate', id) },
}
