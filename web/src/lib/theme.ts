export type ThemeMode = 'light' | 'dark'

const STORAGE_KEY = 'infrapilot-theme'

export function getInitialTheme(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'dark' || stored === 'light') return stored
  } catch {
    // localStorage 不可用时回退浅色
  }
  return 'light'
}

export function applyTheme(theme: ThemeMode): void {
  document.documentElement.dataset.theme = theme
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // 忽略存储失败
  }
}
