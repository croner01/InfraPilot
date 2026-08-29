import './stream-status-line.css'

export function StreamStatusLine({ text }: { text: string }) {
  return (
    <div className="stream-status-line">
      <span className="stream-status-line__dot" />
      <span>{text}</span>
    </div>
  )
}
