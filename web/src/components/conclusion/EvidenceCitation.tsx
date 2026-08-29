import './evidence-citation.css'

export function EvidenceCitation({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="ui-evidence-citation" onClick={onClick}>
      {label}
    </button>
  )
}
