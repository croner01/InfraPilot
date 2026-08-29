import { useState } from 'react'
import { applyTheme, getInitialTheme } from '../../lib/theme.js'
import type { ThemeMode } from '../../lib/theme.js'
import './appearance-section.css'

export function AppearanceSection() {
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme)

  const choose = (mode: ThemeMode) => {
    applyTheme(mode)
    setTheme(mode)
  }

  return (
    <div className="appearance-section">
      <h3 className="appearance-section__title">外观</h3>
      <p className="appearance-section__desc">切换界面主题，选择后立即生效并记住偏好。</p>
      <div className="appearance-section__options">
        <button
          type="button"
          className={`appearance-section__option${theme === 'light' ? ' appearance-section__option--active' : ''}`}
          onClick={() => choose('light')}
        >
          <span className="appearance-section__swatch appearance-section__swatch--light" />
          浅色
        </button>
        <button
          type="button"
          className={`appearance-section__option${theme === 'dark' ? ' appearance-section__option--active' : ''}`}
          onClick={() => choose('dark')}
        >
          <span className="appearance-section__swatch appearance-section__swatch--dark" />
          深色
        </button>
      </div>
    </div>
  )
}
