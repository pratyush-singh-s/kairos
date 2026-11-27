import type { RouteId } from "../app/routes";

/** Simple 20px line icons for the sidebar; decorative (labels carry the meaning). */
const PATHS: Record<RouteId, string> = {
  dashboard: "M3 3h6v8H3zM11 3h6v5h-6zM11 10h6v7h-6zM3 13h6v4H3z",
  timer: "M10 4a7 7 0 1 0 0.01 0M10 7v4l2.5 1.5M8 1.5h4",
  history: "M3.5 10a6.5 6.5 0 1 0 1.9-4.6M3 2.5v3.2h3.2M10 6.5V10l2.5 1.5",
  tasks: "M3 4h3v3H3zM3 13h3v3H3zM9 5.5h8M9 14.5h8M3.5 5.2l1 1 1.8-2",
  deadlines: "M4 3h12v14H4zM4 7h12M7 1.5v3M13 1.5v3M10 10v3l2 1",
  notes: "M5 2h7l4 4v12H5zM12 2v4h4M8 10h5M8 13h5",
  code: "M7 6l-4 4 4 4M13 6l4 4-4 4M11.5 3.5l-3 13",
  calendar: "M3 4h14v13H3zM3 8h14M7 2v4M13 2v4M6 11h2M9 11h2M12 11h2M6 14h2M9 14h2",
  stats: "M3 17h14M5 14V9M9 14V5M13 14v-3M17 14V7",
  blocking: "M10 3a7 7 0 1 0 0.01 0M5 5l10 10",
  // Two arrows chasing each other round a circle.
  sync: "M4 8.5a6 6 0 0 1 10.6-3.4M16 11.5a6 6 0 0 1-10.6 3.4M14.8 2v3.3h-3.3M5.2 18v-3.3h3.3",
  // A cog: eight rounded teeth around a ring, with a hole in the middle.
  settings:
    "M15.83 7.88 L17.99 8.16 L17.99 11.84 L15.83 12.12 L15.62 12.62 L16.95 14.35 L14.35 16.95 L12.62 15.62 L12.12 15.83 L11.84 17.99 L8.16 17.99 L7.88 15.83 L7.38 15.62 L5.65 16.95 L3.05 14.35 L4.38 12.62 L4.17 12.12 L2.01 11.84 L2.01 8.16 L4.17 7.88 L4.38 7.38 L3.05 5.65 L5.65 3.05 L7.38 4.38 L7.88 4.17 L8.16 2.01 L11.84 2.01 L12.12 4.17 L12.62 4.38 L14.35 3.05 L16.95 5.65 L15.62 7.38ZM12.6 10a2.6 2.6 0 1 1-5.2 0a2.6 2.6 0 1 1 5.2 0z",
};

export function Icon(props: { name: RouteId }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[props.name]} />
    </svg>
  );
}

/** Small one-colour symbols drawn in the text colour, used in place of emoji (which Windows draws in its own colours). */
const GLYPHS = {
  // A play triangle with softly rounded corners.
  play: "M5 3.4c0-.8.9-1.3 1.6-.9l6.9 4.6c.6.4.6 1.4 0 1.8l-6.9 4.6c-.7.4-1.6-.1-1.6-.9z",
  // A flame: an outer tongue with a hollow inner one.
  flame:
    "M8.6 1.2c.3 2.1 1.6 3.2 2.7 4.4 1 1.1 1.9 2.3 1.9 4.2A5.2 5.2 0 0 1 8 15a5.2 5.2 0 0 1-5.2-5.2c0-2 1.1-3.4 2.1-4.3-.1 1.3.4 2.3 1.3 2.8-.3-2.7.6-5.1 2.4-7.1zM8 14c1.4 0 2.4-1 2.4-2.4 0-1.3-.9-2.1-1.6-2.9-.3.9-.9 1.5-1.6 1.7.1-.8-.1-1.6-.5-2.2-.7.9-1.1 1.9-1.1 3.4C5.6 13 6.6 14 8 14z",
} as const;

export type GlyphName = keyof typeof GLYPHS;

export function Glyph(props: { name: GlyphName; className?: string }) {
  return (
    <svg className={`glyph ${props.className ?? ""}`} width="1em" height="1em" viewBox="0 0 16 16" fill="currentColor" fillRule="evenodd" aria-hidden="true" focusable="false">
      <path d={GLYPHS[props.name]} />
    </svg>
  );
}
