# Manual tests — `web` (web-viewer on real devices)

Owned by the `web` workstream (`docs/plan/web.md`). Playwright covers the logic on emulated devices
(`web-viewer/e2e/`), but Playwright WebKit is **not** Safari and headless Chromium has no browser toolbar, no real
pinch-zoom inertia and no GPU, so the steps below are run by a person on real hardware before a release and
whenever a task below changes the touch, layout or rendering code. Each task that adds a step names it in its
plan row.

## Setup

- A relay reachable from the device over **HTTPS** (the page needs a secure context: `crypto.subtle` verifies the
  snapshot SHA-256, §6.3; plain `http://<LAN IP>` is not one), serving this build on the same origin (ADR 0006).
  None exists yet: `relay-server` is not on `main`, and the relay stub of tools/fake-slicer (used by the WEB-10
  smoke) runs only inside tests and keeps no snapshot. The device runs below wait for `SRV-22` or the deployment
  (`DEP-`) — `[TODO]` the exact commands come with them.
- A publisher: 3D Slicer with the plugin, or the fake-slicer CLI started **directly** from the repository root —
  `node_modules/.bin/fake-slicer --relay wss://<host>/ws --fixture large-synthetic.glb --code-fd 3 3>code.txt`
  (not through `npx` or `npm run`, which do not pass fd 3 on; the code is read from the file, never from the
  console — NFR-12).
- Fixtures from `shared/fixtures/glb/`: `asymmetric-2nodes.glb` (default), `large-synthetic.glb` (4.9 MB).
- Record every run in **Results** at the end (one row per device and build).

## iPhone Safari

Devices: one iPhone with iOS ≥ 16.4 and one with iOS 15.x if available (R-02, NFR-25). Safari, not an in-app browser.

### Join and view (WEB-10, NFR-01)

Publisher on the computer, phone on **4G** (Wi-Fi off). Use the largest fixture available (`large-synthetic.glb`,
4.9 MB; a 10 MB fixture for the NFR-01 figure is `[TODO]` with PRO), start a stopwatch on **Join**.

1. Type the code from the publisher and tap **Join**. **Expect:** "Joining…", then the model; it is drawn within
   10 s of tapping Join for a 10 MB scene (NFR-01) — record the time and the file size.
2. Open **Structures**. **Expect:** one row per structure of the fixture, in the publisher's order.
3. Check the address bar. **Expect:** no code in it at any time.
4. On a second run, switch on airplane mode during "Joining…", wait 30 s, switch it off. **Expect:** the code
   entry is usable again with a message ("connection lost" or "Scene could not be downloaded") and the code still
   typed; **Join** tries again and shows the model.

### Code entry (WEB-03, WEB-04)

1. Open the viewer URL. **Expect:** five empty cells, the keyboard shows capitals (`autocapitalize`), no
   autocorrect suggestions.
2. Type the code in lower case. **Expect:** upper case in the cells, focus advances by itself, Join becomes active
   after the fifth character.
3. Copy the code from Notes and paste it into the first cell. **Expect:** all five cells are filled.
4. Tap a filled cell and type another character. **Expect:** it replaces the character (WEB-03 review: `select()`
   on focus is unreliable on iOS — note the result).
5. Type `O` or `1`. **Expect:** the cell is marked invalid with the ADR 0008 hint.
6. Pinch-zoom the code entry page. **Expect:** the page zooms (it stays zoomable for low vision).

### Viewer and controls (WEB-08)

Join with a valid code (`asymmetric-2nodes.glb`).

1. **Expect:** the code entry disappears, the model fills the screen from the front (the patient's face towards
   you), VoiceOver (if on) reads the canvas label with the gestures.
2. One finger drag. **Expect:** the model turns about its centre and keeps turning briefly after release
   (damping), then stops; the page does not scroll or bounce.
3. Two fingers spread / pinch. **Expect:** the model gets bigger / smaller; the **page** does not zoom (Safari
   ignores `user-scalable=no`; the viewer blocks `gesturestart`/`gesturechange` on the canvas).
4. Two fingers moved together in one direction. **Expect:** the model pans.
5. Double tap the canvas quickly. **Expect:** the view re-frames the visible model, keeping the direction you
   rotated to; the page does not zoom (Safari's double-tap zoom). A slow second tap or a tap after a drag does
   nothing.
6. Long press the canvas. **Expect:** no callout, no text selection, no magnifier.
7. Tap **Fit view** (bottom right). **Expect:** the button sits inside the safe area (not under the home
   indicator or the rounded corner, also in landscape) and re-frames like step 5.
8. With the model shown, open the page menu in the address bar (**aA**) → **Hide Toolbar**, then tap the bottom
   edge to bring the toolbar back (the page cannot scroll, so the bar never collapses by itself; menu wording varies
   between iOS versions). **Expect:** the canvas always fills the visible area (`100dvh`), no strip below it, no
   jump of the model.
9. Rotate the phone to landscape and back. **Expect:** the canvas fills the screen including the notch side, the
   model stays sharp (no stretched or blurry frame) and centred.
10. Pinch-zoom the code entry page first (step 6 of Code entry), then join. **Expect:** the viewer still covers
    the visible area and **Fit view** is reachable; after leaving, the page zoom is as before.
11. Leave the phone untouched for 30 s with the model visible. **Expect:** no battery drain or heat beyond the
    idle page (render on demand — nothing is drawn while still; optional: Safari Web Inspector → Timelines shows
    no rendering frames).
12. Switch to another app for 10 s and come back. **Expect:** if the connection survived, the model is drawn
    again at once with the same camera; if Safari closed it meanwhile, the code entry says the connection was lost,
    with the code still typed, and **Join** shows the same model with the same camera (automatic reconnect is
    WEB-14). Both pass for WEB-08 — note which one happened.

### Node panel (WEB-09)

Joined with `asymmetric-2nodes.glb` (the opaque "Liver" encloses the translucent "Tumor").

1. Tap **Structures (2)** (bottom left). **Expect:** the list opens above the button with the rows "Liver" and
   "Tumor", each with its colour dot and an eye; it covers at most half of the screen and **Fit view** stays
   visible and tappable.
2. Tap the "Liver" row. **Expect:** the liver disappears at once and the tumour inside shows; the row turns grey
   with a crossed-out eye. VoiceOver (if on) reads the row as a switch, now off.
3. Tap **Show all**. **Expect:** the liver is back, the model has not moved, **Show all** is greyed out.
4. Drag on the canvas just above the open list and beside it. **Expect:** the model rotates (only the list and
   the buttons take touches).
5. Rotate to landscape with the list open. **Expect:** every row is reachable, the list does not cover the
   **Fit view** button, and a message over the scene (if one is shown) sits to the right of the list.
6. Join with `large-synthetic.glb` (four spheres, one hidden in the snapshot). **Expect:** that row starts
   crossed out and its sphere is not drawn.

### Download in the background (WEB-06 review, WEB-10)

1. Join with `large-synthetic.glb` on a slow network (Settings → Developer → Network Link Conditioner "3G"), and
   switch to another app while it downloads; return after 5 s. **Expect:** the download completes or restarts
   once; no "stalled" error right after returning.

## Android Chrome

Devices: a current Chrome and the previous major (NFR-26). Run the **iPhone Safari** steps above with these
differences:

- Code entry step 1: the keyboard may show lower case; typing still shows upper case in the cells.
- Viewer step 3: Chrome honours `touch-action: none`, so the page must not zoom either.
- Viewer step 8: Chrome's URL bar stays expanded on this page (it does not scroll); resize instead with
  split-screen (drag the divider) and with rotation (step 9). **Expect:** the canvas follows, no strip.
- Viewer step 11: `chrome://inspect` → Performance shows no frames while idle (optional).

## Quest Browser

Filled in by WEB-19 / WEB-20 (WebXR entry, hands and controllers, 72 Hz; NFR-27).

## Results

| Date | Tester | Device / OS | Browser + version | Build (git SHA) | Sections | Result / notes |
|------|--------|-------------|-------------------|-----------------|----------|----------------|
|      |        |             |                   |                 |          |                |
