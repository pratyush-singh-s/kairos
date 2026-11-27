import { Icon } from "../components/Icon";
import { altKeyAt, visibleRoutes, type RouteId } from "./routes";
import { nextSidebarMode, useUi } from "../theme/UiProvider";

const MODE_NAMES = { full: "Full menu", icons: "Icons only", hidden: "Hidden menu" } as const;

/**
 * The menu, in one of three styles (Settings, the button, or Ctrl+B): full, icons only, or
 * hidden, where pages fill the window and the menu slides out over them on a left-to-right
 * swipe or when the mouse touches the left edge (`peek`).
 */
export function Sidebar(props: { current: RouteId; onNavigate: (id: RouteId) => void; peek: boolean; onClose: () => void }) {
  const { theme, sidebarMode: mode, update } = useUi();
  const hidden = mode === "hidden";
  // Icons only, unless the hidden menu is sliding out (then it shows in full).
  const icons = mode === "icons";
  const nextMode = nextSidebarMode(mode);
  return (
    <nav
      className="sidebar"
      aria-label="Main"
      data-hidden={hidden}
      data-mode={mode}
      data-peek={props.peek}
      inert={hidden && !props.peek ? true : undefined}
      onMouseLeave={() => hidden && props.onClose()}
    >
      <div className="sidebar-head">
        {!icons && <div className="brand">Kairos</div>}
        <button
          type="button"
          className="collapse-button"
          aria-label={`Menu style: ${MODE_NAMES[mode]}. Switch to ${MODE_NAMES[nextMode]}`}
          title={`Switch to: ${MODE_NAMES[nextMode]} (Ctrl+B)`}
          onClick={() => {
            update("sidebarMode", nextMode);
            props.onClose();
          }}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M9 4v16" />
            <path d={mode === "hidden" ? "M13 10l2 2-2 2" : "M16 10l-2 2 2 2"} />
          </svg>
        </button>
      </div>
      <ul>
        {visibleRoutes(theme).map((r, i) => {
          const key = altKeyAt(i);
          const soon = r.arrivesInPhase !== undefined;
          return (
            <li key={r.id}>
              <button
                type="button"
                className="nav-item"
                aria-current={props.current === r.id ? "page" : undefined}
                aria-label={icons ? `${r.label}${soon ? " (soon)" : ""}` : undefined}
                title={icons ? `${r.label}${key ? ` (Alt+${key})` : ""}` : key ? `Alt+${key}` : undefined}
                onClick={() => props.onNavigate(r.id)}
              >
                <span className="nav-icon">
                  <Icon name={r.id} />
                </span>
                {!icons && <span>{r.label}</span>}
                {!icons && soon && <span className="nav-soon">Soon</span>}
                {!icons && key && theme === "terminal" && (
                  <span className="nav-key" aria-hidden="true">
                    {key}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {/* No theme button here: Ps wants the theme switched only in Settings (0.21.106.B). */}
    </nav>
  );
}
