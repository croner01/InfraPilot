import type { Meta, StoryObj } from '@storybook/react-vite'
import { AlertCenter } from './AlertCenter.js'

const meta: Meta<typeof AlertCenter> = {
  title: 'alerts/AlertCenter',
  component: AlertCenter,
}
export default meta
type Story = StoryObj<typeof AlertCenter>

export const Default: Story = {
  args: {
    loading: false,
    alerts: [
      {
        id: 'a1', severity: 'p0', title: 'order-api Pod CrashLoopBackOff', source: 'order-service/order-api · Prometheus',
        service: 'order-api', startedAt: '2026-08-25T10:24:00Z', status: 'firing', count: 6,
        labels: { namespace: 'order-service', pod: 'order-api-7f9d8b6c-x2kq', cloud_name: '云贯标' },
        annotations: { description: 'Pod 连续 6 次重启，最近退出码 137（OOMKilled）' },
      },
      { id: 'a2', severity: 'p1', title: 'payment-service 5xx 上升', source: 'pay/payment-service · Prometheus', service: 'payment-service', startedAt: '2026-08-25T10:02:00Z', status: 'firing' },
      { id: 'a3', severity: 'p2', title: 'node-08 磁盘使用率 > 80%', source: 'k8s-node · node_exporter', service: 'node-08', startedAt: '2026-08-25T09:41:00Z', status: 'acknowledged' },
    ],
    onInvestigate: (id: string) => console.log('investigate', id),
  },
}
