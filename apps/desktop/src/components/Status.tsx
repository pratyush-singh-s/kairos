/** A status row that never relies on colour alone: icon + word + detail. */
export function Status(props: { label: string; detail: string; ok?: boolean; failed?: boolean }) {
  const word = props.failed ? "Failed" : props.ok ? "OK" : "Checking";
  const icon = props.failed ? "✕" : props.ok ? "✓" : "…";
  const tone = props.failed ? "failed" : props.ok ? "ok" : "pending";
  return (
    <div className={`status status-${tone}`}>
      <span className="status-badge" aria-hidden="true">
        {icon}
      </span>
      <span className="status-label">{props.label}</span>
      <span className="status-word">{word}</span>
      <span className="status-detail">{props.detail}</span>
    </div>
  );
}
