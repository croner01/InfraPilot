import './evidence-citation.css'

export function EvidenceCitation({
  label,
  onClick,
  title,
}: {
  label: string
  onClick: () => void
  /** 该证据支撑/反驳的结论片段（后端 evidenceChain[].claim），作为悬停说明 */
  title?: string | null
}) {
  return (
    <button type="button" className="ui-evidence-citation" title={title ?? undefined} onClick={onClick}>
      {label}
    </button>
  )
}
