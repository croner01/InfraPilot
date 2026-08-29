import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MessageAssistant } from './MessageAssistant.js'

describe('MessageAssistant', () => {
  it('renders avatar and markdown content', () => {
    render(<MessageAssistant content={'### 初步判断\n\n- Pod 状态 **CrashLoopBackOff**'} />)
    expect(screen.getByText('AI')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('初步判断')
    expect(screen.getByRole('list')).toBeInTheDocument()
  })
})
