import './badge.css'

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger' | 'info' | 'orange'

interface BadgeProps {
  label: string
  tone?: BadgeTone
}

export function Badge({ label, tone = 'neutral' }: BadgeProps) {
  return <span className={`ui-badge ui-badge--${tone}`}>{label}</span>
}
