import { Markdown } from '../ui/Markdown.js'
import './message-assistant.css'

export function MessageAssistant({ content, live = false }: { content: string; live?: boolean }) {
  return (
    <div className={`msg-assistant${live ? ' msg-assistant--live' : ''}`}>
      <div className="msg-assistant__avatar">AI</div>
      <div className="msg-assistant__body">
        <Markdown>{content}</Markdown>
      </div>
    </div>
  )
}
