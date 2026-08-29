import type { Meta, StoryObj } from '@storybook/react-vite'
import { HealthGrid } from './HealthGrid.js'

const meta: Meta<typeof HealthGrid> = {
  title: 'alerts/HealthGrid',
  component: HealthGrid,
}
export default meta
type Story = StoryObj<typeof HealthGrid>

export const Default: Story = {
  args: {
    services: [
      { name: 'order-api', meta: 'order-service · 3 副本', status: 'err', metricLabel: '内存占用', metricValue: '98%', chart: [10, 12, 15, 22, 30] },
      { name: 'gateway', meta: 'edge · 2 副本', status: 'ok', metricLabel: '请求延迟 p99', metricValue: '42ms', chart: [20, 18, 21, 19, 20] },
      { name: 'payment-service', meta: 'pay · 2 副本', status: 'warn', metricLabel: '5xx 比例', metricValue: '1.8%', chart: [12, 14, 16, 20, 24] },
    ],
  },
}
