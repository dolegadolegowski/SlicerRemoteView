# Research: web app manifest details for the installable viewer (WEB-17)

Sources for the three manifest/meta choices in `web-viewer/public/manifest.webmanifest` and `web-viewer/index.html`
that `docs/research/web.md` §2.6 does not cover (CLAUDE.md rule 5). Checked on 2026-10-20 in the sources' own
repositories (the rendered sites were not reachable from the sandbox); links are pinned to the commits read.

## 1. Maskable icon safe zone

- W3C Web Application Manifest, §"Icon masks and safe zone" (`#icon-masks`): "The safe zone is the area within a
  maskable icon which is guaranteed to always be visible, regardless of user agent preferences. It is defined as a
  circle with center point in the center of the icon and with a radius of 2/5 (40%) of the icon size" — so a
  diameter of 80 % of the icon. Pixels outside it may be masked away. [1]
- Measured on `public/icons/icon-512.png` (the icon named with `purpose: "maskable"`, RGB, opaque, all four corners
  `#0b0f14`): the farthest pixel that differs at all from the corner colour is 180.8 px from the centre, 35.3 % of
  512 px (179.8 px, 35.1 %, when anti-aliasing differences of ≤ 24 summed RGB are ignored), inside the 204.8 px safe
  zone; the background colour fills the whole square, so any mask shape shows no transparent corners.
- MDN: `maskable` means the parts outside the safe zone "can be ignored and masked away"; `any` (the default) means
  any context; one entry may name several purposes [3]. The manifest lists the 512 px file twice (`any`, then
  `maskable`), which is equivalent to one `"any maskable"` entry; it works for both only because the artwork already
  sits inside the safe zone on an opaque square (above).

## 2. Manifest `id`

- MDN: `id` is a URL resolved against the origin of `start_url` (fragments are dropped, query parameters kept); when
  it is missing or invalid, `start_url` is used. A browser treats a manifest whose `id` matches an installed app as an
  update of that app, and one with a new `id` as a different app, whatever URL it is served from [2].
- So `"id": "/"` with `"start_url": "/"` gives the same identity as no `id` today, but fixes it: a later
  `start_url` change (for example a `?source=pwa` query) does not turn existing installs into a second app. The `id`
  is only an identifier; nothing is fetched from it [2].

## 3. `mobile-web-app-capable`

- Chromium reads `<meta name="mobile-web-app-capable" content="yes">` into the page's web-app metadata, and falls
  back to `apple-mobile-web-app-capable` only when the unprefixed one is absent [4]. When only the Apple name is
  present it logs the console warning `<meta name="apple-mobile-web-app-capable" content="yes"> is deprecated.
  Please include <meta name="mobile-web-app-capable" content="yes">` [5].
- `index.html` therefore carries both: the unprefixed one for Chrome (no warning), the Apple one for iOS before 16.4,
  which has no manifest-based standalone mode (`docs/research/web.md` §2.6 [27], [28]). On Android the manifest's
  `display: standalone` decides the installed app's look; the meta only matters for Chrome's legacy "Add to Home
  screen" shortcut path `[TODO verify]` (not traced further in Chromium).

## Sources

1. W3C Web Application Manifest, editor's draft source, §Icon masks and safe zone —
   https://github.com/w3c/manifest/blob/004ad627062a1efb2ba228e0ac1a6379753699d8/index.html (section
   `id="icon-masks"`); rendered: https://www.w3.org/TR/appmanifest/#icon-masks
2. MDN, "id" manifest member —
   https://github.com/mdn/content/blob/05c1aed375bab88f322b15319e45fb326e4a341c/files/en-us/web/progressive_web_apps/manifest/reference/id/index.md;
   rendered: https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/id
3. MDN, "icons" manifest member (`purpose`) —
   https://github.com/mdn/content/blob/05c1aed375bab88f322b15319e45fb326e4a341c/files/en-us/web/progressive_web_apps/manifest/reference/icons/index.md
4. Chromium, `components/webapps/renderer/web_page_metadata_extraction.cc` lines 108–116 —
   https://github.com/chromium/chromium/blob/a96c702e8b78f862544206e10b05d7d15407f910/components/webapps/renderer/web_page_metadata_extraction.cc#L108-L116
5. Chromium, `components/webapps/renderer/web_page_metadata_agent.cc` lines 50–57 —
   https://github.com/chromium/chromium/blob/a96c702e8b78f862544206e10b05d7d15407f910/components/webapps/renderer/web_page_metadata_agent.cc#L50-L57
