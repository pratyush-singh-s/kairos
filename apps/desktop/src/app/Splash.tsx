import { useEffect, useState } from "react";
import { getAppInfo } from "../ipc/appInfo";
import { Logo } from "../components/Logo";

const SEEN_KEY = "kairos.splashVersion";
/** How long the start screen stays before it fades out. */
const SHOW_MS = 3600;
const LEAVE_MS = 700;
/** Settings → Diagnostics → "Play start animation" fires this. */
export const SPLASH_EVENT = "kairos-splash";

export function playSplash() {
  window.dispatchEvent(new Event(SPLASH_EVENT));
}

/** Icon, name and version, shown once after a new install or an update. Click or any key skips it. */
export function Splash() {
  const [version, setVersion] = useState<string | null>(null);
  const [run, setRun] = useState(0);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    getAppInfo()
      .then((info) => {
        let seen: string | null = null;
        try {
          seen = localStorage.getItem(SEEN_KEY);
        } catch {
          // No storage: show it.
        }
        if (seen !== info.version) setVersion(info.version);
      })
      .catch(() => {
        // Not inside the app (browser preview): no splash.
      });
    const replay = () => {
      getAppInfo()
        .then((info) => {
          setLeaving(false);
          setVersion(info.version);
          setRun((n) => n + 1);
        })
        .catch(() => {});
    };
    window.addEventListener(SPLASH_EVENT, replay);
    return () => window.removeEventListener(SPLASH_EVENT, replay);
  }, []);

  useEffect(() => {
    if (!version) return;
    let timer = 0;
    let done = false;
    const close = () => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      try {
        localStorage.setItem(SEEN_KEY, version);
      } catch {
        // Shown again next time; harmless.
      }
      setLeaving(true);
      timer = window.setTimeout(() => {
        setVersion(null);
        setLeaving(false);
      }, LEAVE_MS);
    };
    // A start at Windows sign-in opens hidden: wait until the window is actually seen.
    const start = () => {
      if (timer || document.visibilityState !== "visible") return;
      timer = window.setTimeout(close, SHOW_MS);
    };
    start();
    document.addEventListener("visibilitychange", start);
    window.addEventListener("focus", start);
    window.addEventListener("keydown", close);
    window.addEventListener("splash-skip", close);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", start);
      window.removeEventListener("focus", start);
      window.removeEventListener("keydown", close);
      window.removeEventListener("splash-skip", close);
    };
  }, [version, run]);

  if (!version) return null;
  return (
    <div
      key={run}
      className="splash"
      data-leaving={leaving || undefined}
      role="dialog"
      aria-label={`Kairos ${version}`}
      onClick={() => window.dispatchEvent(new Event("splash-skip"))}
    >
      <div className="splash-mid">
        <span className="splash-glow" aria-hidden="true" />
        <Logo size={120} className="splash-icon" />
        <h1 className="splash-title" aria-hidden="true">
          {"Kairos".split("").map((c, i) => (
            <span key={i} style={{ animationDelay: `${700 + i * 70}ms` }}>
              {c}
            </span>
          ))}
        </h1>
        <span className="splash-line" aria-hidden="true">
          <span />
        </span>
      </div>
      <span className="splash-version">{version}</span>
    </div>
  );
}
