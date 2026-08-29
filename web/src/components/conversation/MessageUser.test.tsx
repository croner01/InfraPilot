import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MessageUser } from './MessageUser.js'

describe('MessageUser', () => {
  it('renders user message content', () => {
    render(<MessageUser content="order-api Pod 一直在重启" />)
    const body = screen.getByText('order-api Pod 一直在重启')
    expect(body.className).toContain('msg-user__body')
  })
})
