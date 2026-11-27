import { useEffect } from "react";
import { useUi } from "../theme/UiProvider";

/**
 * The old screen's sound (Terminal theme, with the CRT effect and its sound switched on), made in
 * code: a power-on thump with the degauss buzz and a crackle of static, then a quiet mains hum
 * and the faint high whine of the picture tube for as long as the window is open and visible.
 */

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null; // no audio device
  }
}

function noiseBuffer(c: AudioContext, seconds: number): AudioBuffer {
  const b = c.createBuffer(1, Math.floor(c.sampleRate * seconds), c.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

/** Power on: a deep thump, the degauss "bwoom" buzz, and a short crackle of static. */
export function playCrtOn(volume: number) {
  const c = audio();
  if (!c) return;
  const v = Math.max(0, Math.min(1, volume / 100));
  const t = c.currentTime + 0.02;
  const out = c.createGain();
  out.gain.value = v;
  out.connect(c.destination);

  const thump = c.createOscillator();
  thump.frequency.setValueAtTime(70, t);
  thump.frequency.exponentialRampToValueAtTime(32, t + 0.35);
  const tg = c.createGain();
  tg.gain.setValueAtTime(0.0001, t);
  tg.gain.exponentialRampToValueAtTime(0.5, t + 0.01);
  tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
  thump.connect(tg).connect(out);
  thump.start(t);
  thump.stop(t + 0.5);

  // Degauss: a 50 Hz buzz that swells and fades over most of a second.
  const buzz = c.createOscillator();
  buzz.type = "sawtooth";
  buzz.frequency.value = 50;
  const lp = c.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 420;
  const bg = c.createGain();
  bg.gain.setValueAtTime(0.0001, t + 0.05);
  bg.gain.exponentialRampToValueAtTime(0.16, t + 0.18);
  bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.95);
  buzz.connect(lp).connect(bg).connect(out);
  buzz.start(t + 0.05);
  buzz.stop(t + 1);

  // Static as the screen charges.
  const crackle = c.createBufferSource();
  crackle.buffer = noiseBuffer(c, 0.5);
  const hp = c.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 2500;
  const cg = c.createGain();
  cg.gain.setValueAtTime(0.0001, t);
  cg.gain.exponentialRampToValueAtTime(0.08, t + 0.03);
  cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
  crackle.connect(hp).connect(cg).connect(out);
  crackle.start(t);
}

/** Starts the steady hum and whine; returns a function that fades them out. */
function startHum(volume: number): () => void {
  const c = audio();
  if (!c) return () => {};
  const v = Math.max(0, Math.min(1, volume / 100));
  const out = c.createGain();
  out.gain.setValueAtTime(0.0001, c.currentTime);
  out.gain.exponentialRampToValueAtTime(Math.max(0.0001, v), c.currentTime + 1.2);
  out.connect(c.destination);
  const parts: AudioScheduledSourceNode[] = [];
  // Mains hum: 50 Hz with its first harmonics, very quiet.
  for (const [f, g] of [
    [50, 0.012],
    [100, 0.008],
    [150, 0.004],
  ] as const) {
    const o = c.createOscillator();
    o.frequency.value = f;
    const gn = c.createGain();
    gn.gain.value = g;
    o.connect(gn).connect(out);
    o.start();
    parts.push(o);
  }
  // The picture tube's whine (15.7 kHz), barely there, as on a real set.
  const whine = c.createOscillator();
  whine.frequency.value = 15734;
  const wg = c.createGain();
  wg.gain.value = 0.0035;
  whine.connect(wg).connect(out);
  whine.start();
  parts.push(whine);
  return () => {
    const now = c.currentTime;
    out.gain.cancelScheduledValues(now);
    out.gain.setValueAtTime(out.gain.value, now);
    out.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
    for (const p of parts) p.stop(now + 0.35);
  };
}

/** Plays the old screen's sound while it is switched on. */
export function useCrtSound() {
  const { theme, terminalCrt, terminalCrtSound, keyVolume } = useUi();
  const on = theme === "terminal" && terminalCrt && terminalCrtSound;

  useEffect(() => {
    if (!on) return;
    let stop: (() => void) | null = null;
    let started = false;
    const begin = () => {
      if (stop || document.hidden) return;
      if (!started) playCrtOn(keyVolume);
      started = true;
      stop = startHum(keyVolume);
    };
    const end = () => {
      stop?.();
      stop = null;
    };
    // Windows may hold sound back until the first click or key; start then if needed.
    const firstInput = () => {
      if (ctx?.state === "running" && stop) return;
      end();
      begin();
    };
    const onVisible = () => (document.hidden ? end() : begin());
    begin();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pointerdown", firstInput, { once: true, capture: true });
    window.addEventListener("keydown", firstInput, { once: true, capture: true });
    return () => {
      end();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pointerdown", firstInput, true);
      window.removeEventListener("keydown", firstInput, true);
    };
  }, [on, keyVolume]);
}
