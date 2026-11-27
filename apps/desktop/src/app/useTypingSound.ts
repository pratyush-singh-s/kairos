import { useEffect, useRef } from "react";
import type { KeySound } from "../ipc/ui";
import { useUi } from "../theme/UiProvider";

/**
 * Mechanical keyboard sounds, made in code (no recordings). A "thock" is a deep, damped knock:
 * a low tone that drops in pitch plus a muffled tap. "Creamy" is softer and smoother: a rounded,
 * slightly higher tap with no sharp click. Every key varies a little so it never sounds looped;
 * Space, Enter and Backspace are the bigger, deeper stabilised keys; letting go makes a quiet
 * upstroke.
 */

type KeyKind = "key" | "big" | "up";

let ctx: AudioContext | null = null;
let noise: AudioBuffer | null = null;

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext({ latencyHint: "interactive" });
    if (ctx.state === "suspended") void ctx.resume();
    if (!noise) {
      noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.12), ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return ctx;
  } catch {
    return null; // no audio device
  }
}

/** A short decaying tone, falling from `from` Hz to `to` Hz. */
function knock(c: AudioContext, out: AudioNode, at: number, from: number, to: number, gain: number, decay: number) {
  const osc = c.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(from, at);
  osc.frequency.exponentialRampToValueAtTime(to, at + decay);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, at + decay);
  osc.connect(g).connect(out);
  osc.start(at);
  osc.stop(at + decay + 0.02);
}

/** A filtered burst of noise: the tap of plastic on plastic. */
function tap(c: AudioContext, out: AudioNode, at: number, type: BiquadFilterType, freq: number, q: number, gain: number, decay: number) {
  const src = c.createBufferSource();
  src.buffer = noise;
  src.playbackRate.value = 0.9 + Math.random() * 0.2;
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + 0.0015);
  g.gain.exponentialRampToValueAtTime(0.0001, at + decay);
  src.connect(f).connect(g).connect(out);
  src.start(at);
  src.stop(at + decay + 0.02);
}

export function playKey(style: KeySound, volume: number, kind: KeyKind = "key") {
  if (style === "off" || !Number.isFinite(volume) || volume <= 0) return;
  const c = audio();
  if (!c) return;
  const at = c.currentTime + 0.001;
  const v = (volume / 100) ** 1.5 * 0.9;
  const vary = 0.94 + Math.random() * 0.12; // each key a little different
  const big = kind === "big";
  const up = kind === "up";
  const out = c.createGain();
  out.gain.value = v * (up ? 0.35 : big ? 1.15 : 1);
  // Soft top end: nothing harsh even at full volume.
  const shelf = c.createBiquadFilter();
  shelf.type = "lowpass";
  shelf.frequency.value = style === "thock" ? 2600 : 4200;
  out.connect(shelf).connect(c.destination);

  const pitch = vary * (big ? 0.78 : 1) * (up ? 1.5 : 1);
  if (style === "thock" || style === "creamy-thock") {
    const w = style === "thock" ? 1 : 0.75;
    knock(c, out, at, 190 * pitch, 95 * pitch, 0.9 * w, big ? 0.11 : 0.075);
    tap(c, out, at, "lowpass", 1100 * pitch, 0.7, 0.55 * w, big ? 0.05 : 0.035);
  }
  if (style === "creamy" || style === "creamy-thock") {
    const w = style === "creamy" ? 1 : 0.7;
    tap(c, out, at, "bandpass", 1350 * pitch, 1.1, 0.75 * w, big ? 0.045 : 0.03);
    knock(c, out, at, 340 * pitch, 240 * pitch, 0.35 * w, 0.04);
  }
}

function kindOf(e: KeyboardEvent): KeyKind | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === " " || e.key === "Enter" || e.key === "Backspace") return "big";
  if (e.key.length === 1 || e.key === "Tab" || e.key === "Delete") return "key";
  return null;
}

/** Plays the chosen keyboard sound for every key typed anywhere in Focus. */
export function useTypingSound() {
  const { keySound, keyVolume } = useUi();
  const latest = useRef({ keySound, keyVolume });
  latest.current = { keySound, keyVolume };

  useEffect(() => {
    if (keySound === "off") return;
    const held = new Set<string>();
    function down(e: KeyboardEvent) {
      const kind = kindOf(e);
      if (!kind || e.repeat || held.has(e.code)) return;
      held.add(e.code);
      playKey(latest.current.keySound, latest.current.keyVolume, kind);
    }
    function up(e: KeyboardEvent) {
      if (!held.delete(e.code)) return;
      playKey(latest.current.keySound, latest.current.keyVolume, "up");
    }
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
    };
  }, [keySound]);
}
