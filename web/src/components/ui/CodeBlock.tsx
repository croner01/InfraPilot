import { useState } from 'react'
import './code-block.css'

interface CodeBlockProps {
  code: string
  language?: string
  title?: string
}

export function CodeBlock({ code, language = 'text', title }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard 不可用时静默失败
    }
  }

  return (
    <div className="ui-code-block">
      <div className="ui-code-block__head">
        <span className="ui-code-block__lang">{title ?? language}</span>
        <button type="button" className="ui-code-block__copy" onClick={copy}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="ui-code-block__pre">
        <code>{code}</code>
      </pre>
    </div>
  )
}
