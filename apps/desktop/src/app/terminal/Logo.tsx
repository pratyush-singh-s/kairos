/** "KAIROS" in block letters, like the logo on a Neovim start screen. */
export const LOGO_LINES = [
  "██╗  ██╗ █████╗ ██╗██████╗  ██████╗ ███████╗",
  "██║ ██╔╝██╔══██╗██║██╔══██╗██╔═══██╗██╔════╝",
  "█████╔╝ ███████║██║██████╔╝██║   ██║███████╗",
  "██╔═██╗ ██╔══██║██║██╔══██╗██║   ██║╚════██║",
  "██║  ██╗██║  ██║██║██║  ██║╚██████╔╝███████║",
  "╚═╝  ╚═╝╚═╝  ╚═╝╚═╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝",
];

/** The logo, each line shading from the accent colour towards the blue, as in many TUI banners. */
export function Logo(props: { className?: string; tagline?: string }) {
  return (
    <div className={`tui-logo ${props.className ?? ""}`}>
      <pre aria-hidden="true">
        {LOGO_LINES.map((l, i) => (
          <span key={i} style={{ ["--mix" as string]: `${Math.round((i / (LOGO_LINES.length - 1)) * 100)}%` }}>
            {l + "\n"}
          </span>
        ))}
      </pre>
      <span className="visually-hidden">Kairos</span>
      {props.tagline && <p className="tui-logo-tagline">{props.tagline}</p>}
    </div>
  );
}
