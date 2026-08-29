import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CodeBlock } from './CodeBlock.js'

describe('CodeBlock', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders code and copies to clipboard', async () => {
    render(<CodeBlock code="kubectl get pods" language="bash" />)
    expect(screen.getByText('kubectl get pods')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('kubectl get pods')
    await screen.findByRole('button', { name: '已复制' })
  })
})
