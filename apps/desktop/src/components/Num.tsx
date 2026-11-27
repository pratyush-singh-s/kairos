/**
 * A number with its units: "2h 13m" draws the digits big and "h", "m" small and grey
 * (Glass "Data" text style, styles.css "glass text"). Other looks show it as plain text.
 */
export function Num(props: { children: string | number }) {
  const text = String(props.children);
  const parts = text.split(/(\d[\d.,:]*)/).filter((p) => p !== "");
  return (
    <>
      {parts.map((p, i) => (/^\d/.test(p) ? <span key={i}>{p}</span> : <span key={i} className="num-unit">{p}</span>))}
    </>
  );
}
