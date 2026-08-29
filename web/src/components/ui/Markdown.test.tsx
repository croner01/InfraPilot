import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Markdown } from './Markdown.js'

describe('Markdown', () => {
  it('renders headings, lists and inline code', () => {
    render(<Markdown>{'### 初步判断\n\n- 项目 A\n- 项目 B\n\n使用 `kubectl` 查看'}</Markdown>)
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('初步判断')
    expect(screen.getByRole('list')).toBeInTheDocument()
    expect(screen.getByText('kubectl', { selector: 'code' })).toBeInTheDocument()
  })

  it('renders markdown tables', () => {
    render(<Markdown>{'| 服务 | 状态 |\n| --- | --- |\n| order-api | 异常 |'}</Markdown>)
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByText('order-api')).toBeInTheDocument()
  })

  it('strips raw script tags via sanitize', () => {
    render(<Markdown>{'hello <script>window.x=1</script> world'}</Markdown>)
    expect(screen.queryByText(/window\.x=1/)).not.toBeInTheDocument()
    expect(screen.getByText(/hello/)).toBeInTheDocument()
  })
})
