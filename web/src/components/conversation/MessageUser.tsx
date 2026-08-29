import './message-user.css'

export function MessageUser({ content }: { content: string }) {
  return (
    <div className="msg-user">
      <div className="msg-user__body">{content}</div>
    </div>
  )
}
