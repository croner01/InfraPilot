import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Workspace } from './Workspace.js'

describe('Workspace', () => {
  it('renders children in workspace container', () => {
    render(<Workspace>内容</Workspace>)
    expect(screen.getByText('内容')).toBeInTheDocument()
    expect(screen.getByText('内容').className).toContain('ui-workspace')
  })
})
