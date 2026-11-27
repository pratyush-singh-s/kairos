import { useEffect, useState } from "react";

/** How long a new page staggers its panels in; anything added after that appears at once. */
const ENTER_MS = 900;

/**
 * True from the first render of a new `page` until its panels have come in. The page wrapper
 * carries it as data-entering, and the CSS ("page transitions" in styles.css) staggers the
 * panels only while it is set, so a task added later shows up without a wait.
 */
export function usePageEnter(page: string): boolean {
  const [settled, setSettled] = useState<string | null>(null);
  useEffect(() => {
    const t = window.setTimeout(() => setSettled(page), ENTER_MS);
    return () => window.clearTimeout(t);
  }, [page]);
  return settled !== page;
}
