/** Ready-made answers to "Why are you here?"; you can also type your own. */
export const REASONS = ["Need it for work", "Quick check", "Bored", "Habit", "Taking a break"];

/**
 * "Why are you here?" before going through a block screen during focus. The answers show up on
 * the Statistics page, so you can see what pulls you away most.
 */
export function ReasonPicker(props: { value: string; onChange: (v: string) => void; onSubmit?: () => void }) {
  return (
    <form
      className="reason-picker"
      onSubmit={(e) => {
        e.preventDefault();
        if (props.value.trim().length >= 2) props.onSubmit?.();
      }}
    >
      <label htmlFor="reason-input">Why are you here?</label>
      <div className="reason-chips">
        {REASONS.map((r) => (
          <button key={r} type="button" className="chip" data-current={props.value === r} onClick={() => props.onChange(r)}>
            {r}
          </button>
        ))}
      </div>
      <input
        id="reason-input"
        value={props.value}
        maxLength={120}
        autoComplete="off"
        placeholder="Or type your own reason"
        onChange={(e) => props.onChange(e.target.value)}
      />
    </form>
  );
}
