import './message-user.css'

export function MessageUser({ content, time }: { content: string; time?: string }) {
  return (
    <div className="msg-user">
      <div className="msg-user__body">
        {content}
        {time && <div className="msg-user__time">{time}</div>}
      </div>
    </div>
  )
}
