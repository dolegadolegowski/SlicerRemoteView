# Research: detecting Meta Quest Browser for `clientInfo.platform` / `profile` (WEB-15)

Status: research note, written by `architect` on 2026-10-20 for `docs/plan/web.md` WEB-15 (FR-49, FR-70,
US-17; enums in `docs/protocol.md` §5.1, budgets in §7.5). Numbered references `[n]` point to "Sources".

**How sources were read.** The sandbox could not reach `developers.meta.com`, `web.dev`,
`immersive-web.github.io`, `chromium.org` or third-party UA sites directly (DNS/egress refused). So:
- Claims marked **[S]** come from search-engine extracts of the official page. They were cross-checked where
  possible, but nobody fetched the live page.
- Facts from GitHub sources and npm tarballs (Meta's IWER, the web.dev article source, the WebXR spec source,
  MDN browser-compat-data, UA-parser corpora) were read first-hand.
- Real UA strings from parser test corpora are **secondary** (captured traffic, not vendor docs).

## Summary and confidence

| # | Question | Answer | Confidence |
|---|---|---|---|
| 1 | UA format and model token | `Mozilla/5.0 (X11; Linux x86_64; <device token>) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/<ver> Chrome/<ver> VR Safari/537.36`. Device tokens: `Quest`, `Quest 2`, `Quest Pro`, `Quest 3`; **Quest 3S (and 3S Xbox Edition) also send `Quest 3`** | Format high (Meta [S] + Meta IWER source + web.dev + corpora agree). Token table medium-high (Meta [S] only). Quest 3S → `Quest 3`: medium (Meta [S] only, indirectly consistent with corpora) |
| 2 | Modes and look-alikes | Desktop mode is the default; mobile mode changes `VR` → `Mobile VR`. `OculusBrowser/` and the device token appear in both modes. **Pico Browser spoofs** `like Quest` and `OculusBrowser/7.0`. Wolvic sends `Mobile VR` with no device token | Mode token high (Meta [S] + web.dev). Platform part in mobile mode on current builds `[TODO verify]`. Pico spoof medium (secondary corpus only) |
| 3 | `navigator.xr` / UA-CH | `navigator.xr` exists in desktop Chrome/Edge 79+, Chrome Android 79+, Samsung Internet; it is absent in iOS Safari. It is also `[SecureContext]`. So it says nothing about Quest. Quest Browser has `navigator.userAgentData` per BCD, but no source says it exposes the model | `navigator.xr` high (BCD 8.1.6 + spec). UA-CH model on Quest `[TODO verify]` (low) |
| 4 | Rule | `quest-browser` iff the UA has `OculusBrowser/<digit>` and no `PicoBrowser/` / `like Quest`. `quest3` iff the device token is `Quest 3` (or `Quest 3S`). Everything else on Quest Browser (Quest 2, Quest Pro, Quest 1, unknown) → `quest2`. All other browsers → `web` / `mobile` | Recommendation (design choice, see §4) |

## 1. User-agent format and model tokens

### 1.1 Template (desktop mode, the default)

Meta's "Browser specifications" page (it states it was last updated 2026-07-21) gives this example. It also says
not to use the UA string for feature detection, and that Browser/Chromium version numbers change over time [1][S]:

```
Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/39.2.0.0.56.754450099 Chrome/136.0.7103.177 VR Safari/537.36
```

Device-token table on the same page [1][S]: Meta Quest → `Quest`, Quest 2 → `Quest 2`, Quest Pro → `Quest Pro`,
Quest 3 → `Quest 3`, **Quest 3S → `Quest 3`**, **Quest 3S Xbox Edition → `Quest 3`**. The page says the token
"can vary by device", so the table is a set of examples, not a guarantee. Meta's WebXR overview repeats that
WebXR support must not be inferred from the UA [2][S].

### 1.2 Example UAs per headset

| Headset | Example UA (verbatim) | Source / kind |
|---|---|---|
| Quest 3 | `Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/39.2.0.0.56.754450099 Chrome/136.0.7103.177 VR Safari/537.36` | Meta docs [1][S], primary |
| Quest 3 | `Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/32.1.0.37.133.575621010 Chrome/122.0.6261.64 VR Safari/537.36` | device-detector corpus [8], secondary |
| Quest 3S | No primary capture found. Per [1][S] identical to Quest 3 (`Quest 3`). In third-party browsers the Android model is `Quest 3S`, e.g. Yandex: `Mozilla/5.0 (Linux; arm_64; Android 14; Quest 3S) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6998.111 YaBrowser/25.4.4.111.01 Safari/537.36` | [8], secondary; `[TODO verify]` on a 3S in Quest Browser |
| Quest Pro | `Mozilla/5.0 (X11; Linux x86_64; Quest Pro) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/32.1.0.37.133.575621010 Chrome/122.0.6261.64 VR Safari/537.36` | [8], secondary |
| Quest 2 | `Mozilla/5.0 (X11; Linux x86_64; Quest 2) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/18.1.0.2.46.337441587 SamsungBrowser/4.0 Chrome/95.0.4638.74 VR Safari/537.36` (shown wrapped in the article) | web.dev, Google, 2022 [6], primary-ish (captured by the authors) |
| Quest (1) | `Mozilla/5.0 (X11; Linux x86_64; Quest) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/26.2.0.0.10 SamsungBrowser/4.0 Chrome/110.0.5481.192 VR Safari/537.36` | uap-core corpus [7], secondary |

Meta's own emulator runtime IWER (`iwer@2.6.0`, MIT, published 2026-10-13, `lib/device/configs/headset/meta.js`)
hard-codes desktop-mode UAs `(X11; Linux x86_64; Quest 1|Quest 2|Quest Pro|Quest 3) ... OculusBrowser/33.0.0.x.x.x
Chrome/126.0.6478.122 VR Safari/537.36` [4][5]. These strings are synthetic: the version is a placeholder, and
`Quest 1` differs from the docs' `Quest`. They confirm the structure but are not ground truth. IWER also
defines a "Meta VR Glasses" device that reuses the Quest 3 UA. That is emulator behaviour, not a documented
token.

### 1.3 Things that are *not* stable

- **Version numbers.** Through 2025 the Browser used `OculusBrowser/4x.y...` (MDN BCD lists 42.0 = Blink 142,
  2026-01-26, as "current" [10]). The 2026 release notes jump to Chromium-aligned numbers: 144.2, 146.0
  (2026-04-21), 150.1 (2026-08-28), 152.1 (2026-10-02) [3][S]. Do not parse the version. Whether
  144+ builds still emit `OculusBrowser/<ver>` is `[TODO verify]` on a device; the July 2026 doc example still
  shows the token.
- **UA reduction.** Chrome freezes the Android UA to `Linux; Android 10; K` and `Chrome/<major>.0.0.0`, and
  from Chrome 145 this is no longer overridable by policy [12][S]. Quest Browser evidently does not apply it: the
  example has the full Chrome version and a model token. If Meta ever adopts it, the device token would
  disappear, and the rule below degrades safely to `quest2` (see §4).
- **Legacy platform part.** 2020–2021 builds used `(Linux; Android 10; Quest 2)` / `(Linux; Android 7.1.1;
  Quest)`, and early Quest 2 firmware sent `Standalone HMD`; Oculus Go sent `Pacific` [8]. Detection must not
  depend on `X11` or `Android`.

## 2. Modes and look-alike browsers

- **Desktop vs mobile mode.** Desktop mode is the default. In mobile mode the UA contains the token
  `Mobile VR` and Browser applies `<meta name="viewport">`. In desktop mode the token is absent and meta
  viewport is ignored [1][S]. web.dev (2022): "If the user switches to mobile mode, `VR` changes to
  `Mobile VR`" [6]. Neither source says the `OculusBrowser/` or device token changes. A third-party listing shows a
  mobile-mode `(Linux; Android 12; Quest 3) ... OculusBrowser/32... Mobile VR` string `[TODO verify]`, so the
  platform part may switch between `X11; Linux x86_64` and `Linux; Android NN`. **Consequence:** match only
  `OculusBrowser/` plus a `Quest...` item inside the first parenthesis. Never match `X11`, `Android`, `Mobile`
  or `VR`.
- **Pico Browser spoofs Quest.** Captured Pico UAs [8] (secondary; no Pico documentation found, `[TODO verify]`):
  `Mozilla/5.0 (X11; Linux x86_64; PICO 4 OS5.4.0 like Quest) AppleWebKit/537.36 (KHTML, like Gecko) PicoBrowser/3.3.22 Chrome/105.0.5195.68 VR Safari/537.36 OculusBrowser/7.0`
  and the mobile-mode `Mozilla/5.0 (Linux; Android 10; Pico Neo 3 OS5.9.5.0 like Quest) ... PicoBrowser/3.3.36 Chrome/105.0.5195.68 Mobile VR Safari/537.36  OculusBrowser/7.0`.
  A naive `includes('OculusBrowser')` or `includes('Quest')` misclassifies Pico. Exclude `PicoBrowser/` and
  `like Quest`.
- **Wolvic** (Gecko; Quest, Pico and others) sends `Mozilla/5.0 (Android 10; Mobile VR; rv:105.0) Gecko/105.0
  Firefox/105.0 Wolvic/1.3` [9], and `... Android 14; Mobile VR; rv:128.0 ... Wolvic/1.8.1` in [7]. It has no
  device token and no `OculusBrowser`, so `Mobile VR` alone does not mean Quest.
- **Third-party browsers on Quest** (Yandex above) carry `Quest 3S` / `Quest 3` from the Android model but no
  `OculusBrowser`. They are `web` under the rule below (they are not Meta Quest Browser).
- Parser libraries agree that the token is the discriminator: uap-core maps `OculusBrowser/` → "Oculus
  Browser" and `Quest 3|Quest 2|Quest Pro|Quest` → Meta models [7]. device-detector requires
  `(?<!like )Quest.+OculusBrowser` [8]. Do **not** add a dependency for this: `ua-parser-js` 2.x is
  `AGPL-3.0-or-later` [17], and the rule is about 10 lines.

## 3. `navigator.xr`, `isSessionSupported`, UA Client Hints

- `navigator.xr` is `[SecureContext, SameObject]` [11]. On plain `http://` (e.g. a LAN dev server) it is
  undefined **even on Quest**.
- MDN BCD 8.1.6 (2026-10-15) [10], `api.Navigator.xr`: Chrome 79+, Edge 79+, Chrome Android 79+, Samsung
  Internet 11.2+, Quest Browser 8.0+. **Not** in Safari / Safari iOS, Firefox or Android WebView.
  visionOS Safari exposes `immersive-vr` (`docs/research/web.md` §3). So the presence of `navigator.xr` does not
  identify Quest, and absence on iOS is the only safe negative.
- `isSessionSupported(mode)` [11]:
  - It resolves `true` for `inline` always.
  - It resolves `false` when no device is obtained.
  - It MAY resolve `true` for "usually supported" systems.
  - The spec notes that "a certain level of false-positives are expected".
  - It is async, it is gated by the `xr-spatial-tracking` permissions policy, and it reports a mode, not a model.

  Desktop Chrome with an OpenXR runtime, ARCore phones (`immersive-ar`), Pico and Vision Pro can all resolve
  `true`. It cannot tell Quest 2 from Quest 3. Use it only to decide whether to show the XR button (WEB-19),
  not for `platform`/`profile`.
- **UA-CH.** BCD lists `navigator.userAgentData` / `getHighEntropyValues` on Quest Browser since 16.0 and
  `Sec-CH-UA-Model` since 15.0 [10]. BCD's `oculus` entry declares `upstream: chrome_android`, so these values may
  be mirrored rather than tested `[TODO verify]`. No source says whether `model` returns `Quest 3`, `Quest 3S` or
  `""`, or whether `brands` names Quest Browser `[TODO verify]`. `getHighEntropyValues` is async, high-entropy
  and permissions-policy-gated (Chrome 144+) [10]. **Do not use UA-CH in v1.** Record its values once on a
  device (§5) to decide later.

## 4. Recommended rule (normative for WEB-15 unless a later ADR changes it)

The input is `navigator.userAgent` only, read synchronously before `viewer.join` (pure function, unit-testable).
Reference logic (not production code):

```ts
const QUEST_BROWSER = /\bOculusBrowser\/\d/;
const LOOKALIKE = /\bPicoBrowser\/|\blike Quest\b/;           // Pico spoofs both tokens
function detect(ua: string): { platform: 'web' | 'quest-browser'; profile: 'mobile' | 'quest2' | 'quest3' } {
  if (!QUEST_BROWSER.test(ua) || LOOKALIKE.test(ua)) return { platform: 'web', profile: 'mobile' };
  const part = /\(([^)]*)\)/.exec(ua)?.[1] ?? '';              // first parenthesised platform part
  const token = part.split(';').map((s) => s.trim()).find((s) => /^Quest\b/.test(s));
  return { platform: 'quest-browser', profile: token === 'Quest 3' || token === 'Quest 3S' ? 'quest3' : 'quest2' };
}
```

| UA condition | `platform` | `profile` |
|---|---|---|
| no `OculusBrowser/<digit>` (iPhone, iPad, Android, desktop, Wolvic, Yandex on Quest) | `web` | `mobile` |
| `PicoBrowser/` or `like Quest` present | `web` | `mobile` |
| Quest Browser, token `Quest 3` (Quest 3, 3S, 3S Xbox) or `Quest 3S` (defensive) | `quest-browser` | `quest3` |
| Quest Browser, token `Quest 2`, `Quest Pro`, `Quest`, `Quest 1`, `Standalone HMD`, `Pacific`, missing or unknown | `quest-browser` | `quest2` |

Reasoning:
- **`navigator.xr` is deliberately not an input.** The WEB-15 plan text says "via UA `OculusBrowser`/
  `navigator.xr`". `navigator.xr` cannot be OR-ed in, because it exists on desktop and Android Chrome. It cannot
  be AND-ed in either, because it is missing on Quest over `http://`. The web workstream may want to align the
  plan wording; this note does not edit the plan.
- **Budgets (protocol §7.5):** `quest2` = ≤ 500 k triangles / ≤ 60 nodes; `quest3` = ≤ 1 M / ≤ 120.
  - Quest 3 and 3S share XR2 Gen 2 with ~2.5x the Quest 2 GPU, and Meta gives them the 1.3–1.8 M triangle
    range [13][14][S]. So `quest3`.
  - **Quest Pro → `quest2`, not `quest3`.** Meta's performance table groups Quest Pro with Quest 2: 750 k–1 M
    triangles and 80–200 draw calls under busy simulation [13][S]. The memory table gives both a 4.4 GiB
    app limit [15] (see `docs/research/quest.md` §7). Reporting `quest3` would suggest a 1 M / 120-node scene,
    which sits at the very top of Meta's native range for that class, and WebXR has less headroom than
    native (NFR-07). This deviates from the WEB-15 brief ("quest3 for 3/3S/Pro") on purpose.
  - Quest 1 has no lower profile available, so it maps to `quest2`, the strictest profile overall: it shares the
    triangle cap with `mobile` but allows half the nodes.
- **Unknown Quest model → `quest2`.** This covers a missing token after a future UA reduction, a new device
  such as Meta VR Glasses (shipping spring 2027 [16][S]; token undocumented), or an unrecognised string. The
  profile is informational and the publisher chooses the budget (§5.1, §7.5). Under-reporting costs nothing, while
  over-reporting could mislead the instructor. Add new tokens to the table only after Meta's specs page lists
  them. Do not compare model numbers, so "Quest 4" does not silently become `quest3`.
- **Never send `quest2`/`quest3` as `platform` from the web viewer.** Those values belong to the native
  `quest-app` (§5.1 example). The web viewer sends only `web` or `quest-browser`. `other` stays unused by the
  web viewer (default chosen here: Pico and Wolvic are `web`).
- **Privacy:** only the two enum values leave the device. Never put the raw UA, browser version or UA-CH values
  into `clientInfo` (§5.1 "No device identifiers"), and never log them.

## 5. Test matrix and on-device checks

Unit-test matrix for WEB-15 acceptance test 1. Use the strings above verbatim, plus Playwright
`devices['iPhone 15']`, `devices['Pixel 7']` and a desktop Chrome UA for the `web`/`mobile` rows:

| Input | Expected |
|---|---|
| iPhone 15, Pixel 7, desktop Chrome, Wolvic [9], Yandex on Quest 3S [8] | `web` / `mobile` |
| Pico 4 desktop and Pico Neo 3 mobile UAs (§2) | `web` / `mobile` |
| Quest 3 (Meta example [1]) and the same string with `VR` → `Mobile VR` and with `(Linux; Android 12; Quest 3)` (synthetic mobile-mode variants) | `quest-browser` / `quest3` |
| Quest 2 (web.dev [6]), legacy `(Linux; Android 10; Quest 2)` [8], Quest Pro [8], Quest (1) [7], IWER `Quest 1` [4], `Standalone HMD` [8] | `quest-browser` / `quest2` |
| Quest 3 example with the `(...)` token removed or replaced by `Quest 4` (synthetic) | `quest-browser` / `quest2` |

Manual on-device check (to be added by the web workstream to `docs/testing/web.md` §Quest Browser). On Quest 2,
Quest 3, Quest 3S (and Quest Pro if available), current Browser (152.x):
1. Record `navigator.userAgent` in desktop mode and in mobile mode.
2. Record `navigator.userAgentData?.brands/platform/mobile` and `getHighEntropyValues(['model', 'platformVersion'])`.
3. Confirm in remote DevTools (`chrome://inspect`) that the `viewer.join` frame carries the expected
   `platform`/`profile` (the status bar does not show them; `docs/testing/web.md` §Device profile).

These checks resolve the `[TODO verify]` items in §1.3, §2 and §3.

Meta's IWER (MIT) can inject a Quest UA and an emulated `navigator.xr` into Chromium. That makes it a
candidate for WEB-19's E2E tests, not for WEB-15, where plain `userAgent` overrides suffice.

## Open questions

1. Do Browser 144+ builds (Chromium-aligned numbering) still send `OculusBrowser/<ver>` and a device token? `[TODO verify]` on a device.
2. What is the platform part in mobile mode on current builds (`X11; Linux x86_64` vs `Linux; Android NN`)? The rule tolerates both.
3. Is the Quest 3S → `Quest 3` token Meta-documented only? No first-hand capture exists.
4. Is the Pico spoof (`like Quest`, `OculusBrowser/7.0`) known only from a third-party corpus? No Pico documentation was found.
5. What UA-CH values does Quest Browser return (`model`, `brands`)? Is BCD's `oculus` data mirrored from Chrome Android?
6. What device token will Meta VR Glasses use? It is undocumented; the device ships spring 2027.
7. Should non-Quest XR browsers report `other` instead of `web`? The default chosen here is `web`.

## Sources

1. Meta, "Browser specifications" (states updated 2026-07-21) [S] — https://developers.meta.com/horizon/documentation/web/browser-specs/ (mirror path https://developers.meta.com/vr/documentation/web/browser-specs/)
2. Meta, "WebXR overview" [S] — https://developers.meta.com/vr/documentation/web/webxr-overview/
3. Meta, Browser release notes (152.1 on 2026-10-02; 150.1 2026-08-28; 146.0 2026-04-21; Chromium M144 on 2026-03-02) [S] — https://developers.meta.com/horizon/documentation/web/browser-release-notes/ , https://developers.meta.com/horizon/downloads/package/browser/144.2/
4. Meta, Immersive Web Emulation Runtime `iwer@2.6.0` (MIT, npm 2026-10-13), `lib/device/configs/headset/meta.js` — https://github.com/meta-quest/immersive-web-emulation-runtime , https://www.npmjs.com/package/iwer
5. Meta, Immersive Web Emulator 2.0 `src/index.ts` (uses `iwer` `metaQuest3`) — https://github.com/meta-quest/immersive-web-emulator/blob/main/src/index.ts
6. T. Steiner, A. Rodionov, "PWAs on Oculus Quest 2", web.dev, 2022-01-10 (updated 2022-12-04) — https://web.dev/articles/pwas-on-oculus-2 (read from source: https://github.com/GoogleChrome/web.dev/blob/main/src/site/content/en/blog/pwas-on-oculus-2/index.md)
7. ua-parser `uap-core` (master, read 2026-10-20): `regexes.yaml`, `tests/test_*.yaml` — https://github.com/ua-parser/uap-core
8. Matomo `device-detector` (master, read 2026-10-20): `Tests/fixtures/wearable.yml`, `regexes/device/mobiles.yml` — https://github.com/matomo-org/device-detector
9. Igalia, Wolvic v1.3 release notes ("New user agent string") — https://github.com/Igalia/wolvic/releases/tag/v1.3
10. MDN `@mdn/browser-compat-data` 8.1.6 (2026-10-15): `api.Navigator.xr`, `api.XRSystem.isSessionSupported`, `api.Navigator.userAgentData`, `api.NavigatorUAData.getHighEntropyValues`, `http.headers.Sec-CH-UA-Model`, `browsers.oculus` — https://github.com/mdn/browser-compat-data ; MDN pages https://developer.mozilla.org/en-US/docs/Web/API/Navigator/xr , https://developer.mozilla.org/en-US/docs/Web/API/XRSystem/isSessionSupported , https://developer.mozilla.org/en-US/docs/Web/API/Navigator/userAgentData
11. W3C, WebXR Device API (CR; TR dated 2022-03-31; editor's draft `index.bs` on `main`, read 2026-10-20): `partial interface Navigator { [SecureContext, SameObject] readonly attribute XRSystem xr; }`, `isSessionSupported()` algorithm — https://immersive-web.github.io/webxr/ , https://www.w3.org/TR/webxr/ , https://github.com/immersive-web/webxr/blob/main/index.bs
12. Chromium, "User-Agent Reduction"; Chrome 145 release notes (UserAgentReduction policy no longer has effect) [S] — https://www.chromium.org/updates/ua-reduction/ , https://developer.chrome.com/release-notes/145
13. Meta, "Testing and performance analysis" (Unity; Quest 2 and Quest Pro grouped) [S] — https://developers.meta.com/horizon/documentation/unity/unity-perf/
14. Meta, "Device-specific optimization (Quest 3 vs Quest 2)" [S] — https://developers.meta.com/horizon/resources/device-optimization-comparison/
15. Meta, "Memory/RAM" (4.4 GiB Quest 2 / Quest Pro; 5.75 GiB Quest 3 / 3S), via `docs/research/quest.md` §7 — https://developers.meta.com/horizon/documentation/unity/po-memory-ram/
16. Meta, "VR is Expanding. Start Building for Meta VR Glasses Today." (Connect 2026 recap) [S] — https://developers.meta.com/blog/meta-connect-recap-start-building-the-future-of-vr/
17. `ua-parser-js` 2.0.10 (npm), `package.json` licence `AGPL-3.0-or-later`, `src/main/ua-parser.js` — https://github.com/faisalman/ua-parser-js
