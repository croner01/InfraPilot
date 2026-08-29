import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StreamStatusLine } from './StreamStatusLine.js'

describe('StreamStatusLine', () => {
  it('renders status text', () => {
    render(<StreamStatusLine text="正在执行 k8s.describe_pod()…" />)
    expect(screen.getByText('正在执行 k8s.describe_pod()…')).toBeInTheDocument()
  })
})
