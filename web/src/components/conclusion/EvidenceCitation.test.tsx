import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EvidenceCitation } from './EvidenceCitation.js'

describe('EvidenceCitation', () => {
  it('renders label and fires onClick', async () => {
    const onClick = vi.fn()
    const user = userEvent.setup()
    render(<EvidenceCitation label="证据#1 · 主要" onClick={onClick} />)
    const chip = screen.getByRole('button', { name: '证据#1 · 主要' })
    await user.click(chip)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
