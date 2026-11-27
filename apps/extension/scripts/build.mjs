// Bundles the extension into dist/ (load this folder in Firefox) and dist-chrome/ (Chrome, Edge,
// Brave: Manifest V3, with a small shim that maps Firefox's `browser` API onto `chrome`).
import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entryPoints = {
  background: resolve(root, "src/background.ts"),
  popup: resolve(root, "src/popup/popup.ts"),
  options: resolve(root, "src/options/options.ts"),
  blocked: resolve(root, "src/blocked/blocked.ts"),
  youtube: resolve(root, "src/youtube/youtube.ts"),
};

async function bundle(outName, target, banner) {
  const out = resolve(root, outName);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await build({ entryPoints, outdir: out, bundle: true, format: "iife", target, banner: banner ? { js: banner } : undefined, logLevel: "info" });
  await cp(resolve(root, "static"), out, { recursive: true });
  return out;
}

const firefox = await bundle("dist", "firefox140");
console.log(`Extension built in ${firefox}`);

const chrome = await bundle("dist-chrome", "chrome120", await readFile(resolve(root, "scripts/chrome-shim.js"), "utf8"));
// Same version as the Firefox manifest, so the two never drift apart.
const { version } = JSON.parse(await readFile(resolve(root, "static/manifest.json"), "utf8"));
const manifest = JSON.parse(await readFile(resolve(root, "static-chrome/manifest.json"), "utf8"));
await writeFile(resolve(chrome, "manifest.json"), `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
console.log(`Chrome extension built in ${chrome}`);
