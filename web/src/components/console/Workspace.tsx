import type { ReactNode } from 'react'
import './workspace.css'

export function Workspace({ children }: { children: ReactNode }) {
  return <div className="ui-workspace">{children}</div>
}
