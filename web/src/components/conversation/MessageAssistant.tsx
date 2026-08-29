import { Markdown } from '../ui/Markdown.js'
import './message-assistant.css'

export function MessageAssistant({ content }: { content: string }) {
  return (
    <div className="msg-assistant">
      <div className="msg-assistant__avatar">AI</div>
      <div className="msg-assistant__body">
        <Markdown>{content}</Markdown>
      </div>
    </div>
  )
}
