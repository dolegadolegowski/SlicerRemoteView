// Add to Home Screen assets (WEB-17; research web.md §2.6, NFR-25, NFR-26): the manifest meets Chrome's install
// criteria, every icon it names exists with the size it claims, index.html links them, and no service worker exists.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root));
const html = read("index.html").toString("utf8");
const manifest = JSON.parse(read("public/manifest.webmanifest").toString("utf8")) as {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  theme_color: string;
  background_color: string;
  prefer_related_applications?: boolean;
  icons: { src: string; sizes: string; type: string; purpose: string }[];
};

/** Width and height from a PNG's IHDR chunk. */
function pngSize(bytes: Buffer): [number, number] {
  expect(bytes.subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  expect(bytes.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

function sources(dir: URL): string[] {
  return readdirSync(dir).flatMap((name) => {
    const entry = new URL(name, dir);
    return statSync(entry).isDirectory() ? sources(new URL(`${name}/`, dir)) : [entry.pathname];
  });
}

describe("web app manifest (Chrome install criteria)", () => {
  it("has the names, start URL, scope and a standalone display", () => {
    expect(manifest.name).toBe("SlicerRemoteView");
    expect(manifest.short_name.length).toBeLessThanOrEqual(12); // fits under a home-screen icon
    expect(manifest.start_url).toBe("/"); // never /j#CODE: a code must not live in the installed app
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.prefer_related_applications).not.toBe(true);
    expect(manifest.theme_color).toBe("#0b0f14");
    expect(html).toContain('<meta name="theme-color" content="#0b0f14" />');
  });

  it("names 192 px and 512 px PNG icons and a maskable one, each with the size it claims", () => {
    const sizes = manifest.icons.map((i) => i.sizes);
    expect(sizes).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    expect(manifest.icons.some((i) => i.purpose === "maskable")).toBe(true);
    for (const icon of manifest.icons) {
      expect(icon.type).toBe("image/png");
      const [width, height] = pngSize(read(`public${icon.src}`));
      expect(`${width}x${height}`).toBe(icon.sizes);
    }
  });
});

describe("index.html", () => {
  it("links the manifest, an icon and the apple-touch-icon (180 px), with the Apple web-app tags", () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(html).toContain('<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />');
    expect(html).toContain('rel="icon"');
    expect(pngSize(read("public/icons/apple-touch-icon.png"))).toEqual([180, 180]);
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
    expect(html).toContain('name="apple-mobile-web-app-status-bar-style"');
  });
});

describe("no service worker (prompt 03: scene data is never cached)", () => {
  it("no source registers one", () => {
    for (const file of sources(new URL("src/", root)))
      expect(readFileSync(file, "utf8"), file).not.toMatch(/serviceWorker|ServiceWorker/);
  });
});
