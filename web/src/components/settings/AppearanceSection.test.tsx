import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppearanceSection } from './AppearanceSection.js'

describe('AppearanceSection', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('renders light and dark options', () => {
    render(<AppearanceSection />)
    expect(screen.getByRole('button', { name: '浅色' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '深色' })).toBeInTheDocument()
  })

  it('switches to dark theme on click', async () => {
    const user = userEvent.setup()
    render(<AppearanceSection />)
    await user.click(screen.getByRole('button', { name: '深色' }))
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(screen.getByRole('button', { name: '深色' }).className).toContain('appearance-section__option--active')
    expect(localStorage.getItem('infrapilot-theme')).toBe('dark')
  })
})
