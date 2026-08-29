import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Badge } from './Badge.js'

describe('Badge', () => {
  it('renders label with tone class', () => {
    render(<Badge label="P0 严重" tone="danger" />)
    const badge = screen.getByText('P0 严重')
    expect(badge.className).toContain('ui-badge--danger')
  })

  it('defaults to neutral tone', () => {
    render(<Badge label="未处理" />)
    expect(screen.getByText('未处理').className).toContain('ui-badge--neutral')
  })
})
