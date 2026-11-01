import type { Meta, StoryObj } from '@storybook/react-vite'
import { AlertList } from './AlertList.js'

const meta: Meta<typeof AlertList> = {
  title: 'alerts/AlertList',
  component: AlertList,
}
export default meta
type Story = StoryObj<typeof AlertList>

export const Default: Story = {
  args: {
    alerts: [
      { id: 'a1', severity: 'p0', title: 'order-api Pod CrashLoopBackOff', source: 'order-service/order-api · Prometheus', service: 'order-api', startedAt: '2026-08-25T10:24:00Z', status: 'firing', count: 6 },
      { id: 'a2', severity: 'p1', title: 'payment-service 5xx 上升', source: 'pay/payment-service · Prometheus', service: 'payment-service', startedAt: '2026-08-25T10:02:00Z', status: 'firing' },
      { id: 'a3', severity: 'p2', title: 'node-08 磁盘使用率 > 80%', source: 'k8s-node · node_exporter', service: 'node-08', startedAt: '2026-08-25T09:41:00Z', status: 'acknowledged' },
    ],
  },
}
