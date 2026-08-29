import { describe, it, expect, beforeEach } from 'vitest'
import { getInitialTheme, applyTheme } from './theme.js'

describe('theme', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults to light theme', () => {
    expect(getInitialTheme()).toBe('light')
  })

  it('applies and persists the selected theme', () => {
    applyTheme('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem('infrapilot-theme')).toBe('dark')
    expect(getInitialTheme()).toBe('dark')
  })
})
