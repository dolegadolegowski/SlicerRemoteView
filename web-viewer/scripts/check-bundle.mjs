#!/usr/bin/env node
// Bundle budget (WEB-18, NFR-09): after `vite build`, sums the gzipped size of what dist/index.html loads at start —
// module scripts, module preloads and stylesheets — prints it and exits 1 above 1 MiB, or when index.html names no
// module script at all (a parse miss must not pass as 0 B). Icons and the manifest are not part of the initial
// JS + CSS.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

export const BUDGET_BYTES = 1_048_576;

/** Same-origin paths of the JS and CSS that `html` loads at start, in document order, without duplicates. */
export function initialAssets(html) {
  const assets = [];
  const tag = /<(script|link)\b([^>]*)>/gi;
  for (const [, name, attributes] of html.matchAll(tag)) {
    const attr = (key) => {
      const match = new RegExp(`\\b${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(
        attributes,
      );
      return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
    };
    const url =
      name.toLowerCase() === "script"
        ? attr("type") === "module" && attr("src")
        : /^(stylesheet|modulepreload)$/i.test(attr("rel") ?? "") && attr("href");
    if (!url) continue;
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(url))
      throw new Error(`initial asset from another origin: ${url}`);
    if (!assets.includes(url)) assets.push(url);
  }
  return assets;
}

/** Gzipped size (level 9, as a CDN or the relay's compression would at best) of each initial asset in `dist`. */
export function measure(dist) {
  const html = readFileSync(join(dist, "index.html"), "utf8");
  return initialAssets(html).map((url) => {
    const bytes = readFileSync(join(dist, url.replace(/^\//, "")));
    return { url, bytes: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dist = process.argv[2] ?? fileURLToPath(new URL("../dist", import.meta.url));
  const files = measure(dist);
  if (!files.some((f) => /\.m?js$/i.test(f.url))) {
    console.error("no module script found in index.html: nothing measured");
    process.exit(1);
  }
  const total = files.reduce((sum, f) => sum + f.gzip, 0);
  for (const f of files) console.log(`  ${f.url}  ${f.bytes} B, ${f.gzip} B gzip`);
  console.log(`initial JS + CSS: ${total} B gzip (budget ${BUDGET_BYTES} B, NFR-09)`);
  if (total > BUDGET_BYTES) {
    console.error(`bundle over budget by ${total - BUDGET_BYTES} B`);
    process.exit(1);
  }
}
