/** The Kairos logo drawn in the theme's colours: the line art is a mask filled with the accent colour. */
export const LOGO_MARK = "/app-mark.png";

export function Logo(props: { size: number; className?: string }) {
  return <span className={`app-logo ${props.className ?? ""}`} style={{ width: props.size, height: props.size }} aria-hidden="true"><span /></span>;
}
