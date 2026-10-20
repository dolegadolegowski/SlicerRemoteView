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
4. On a second run, switch on airplane mode during "Joining…", wait 30 s, switch it off. **Expect** one of: the
   code entry usable again with "Scene could not be downloaded" or "connection lost" and the code still typed
   (the download gave up, or the socket dropped before the join was answered) — **Join** tries again and shows the
   model; or "Reconnecting…" under a busy Join and then the model by itself (the socket dropped after the join,
   WEB-14).

### Deep link (WEB-11, US-07)

The publisher shows a QR of `https://<host>/j#<CODE>` (Slicer FR-04, or make one from the link fake-slicer writes to
`code.txt`).

1. Scan the QR with the **Camera** app and tap the banner. **Expect:** Safari opens, the cells show the code, the
   viewer joins without a tap and shows the model.
2. Look at the address bar, the tabs overview and the long-press Back list. **Expect:** `…/j` only, no code. Then
   open Safari's **History** list and record what it shows: the browser records the opened `…/j#<CODE>` before any
   script runs and no page can remove it (known residual, limited by the code's expiry and the session's end —
   `docs/testing/reports/2026-10-20-web-1.md`).
3. Edit the link to a wrong code (e.g. replace a letter with `0`) and open it in a **new tab** (no session is live
   there). **Expect:** the code entry with the `0`/`O` hint, Join disabled, nothing joins.
4. With the viewer open, paste the link of another session into the address bar. **Expect:** it joins that
   session; the address bar shows `…/j`. A link with a wrong code pasted the same way shows a notice over the scene
   and the session goes on.

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
    again at once with the same camera; if Safari closed it meanwhile, "Reconnecting…" over the same model and
    then "Connected again", with the same camera and nothing typed (WEB-14). Note which one happened.

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

### Live updates (WEB-12)

Start the publisher with an update script: `node_modules/.bin/fake-slicer --relay wss://<host>/ws --script
toggle-visibility --loop --code-fd 3 3>code.txt` (other scripts: `colour-cycle`, `move-node`, `reload-scene`).

1. Join. **Expect:** about a second after the model appears, the liver disappears and comes back, then the tumour;
   the switches in **Structures** follow.
2. Hide the tumour in the panel while the liver is toggled by the presenter. **Expect:** the tumour stays hidden
   (the presenter did not change it); when the presenter next hides and shows the tumour, its switch follows the
   presenter again.
3. `colour-cycle`: **Expect:** colours and transparency change on screen and in the swatches. `move-node`: the
   tumour moves in three 0.5 s steps and then stops at the scene origin (the script's last matrix), not at its
   starting place. `reload-scene`: "Updating the scene…" appears briefly, then the scene shows "Vessel".
4. Switch on airplane mode for 5 s during `toggle-visibility --loop`, then off (the viewer rejoins by itself since
   WEB-14). **Expect:** the scene shows the presenter's current state (no node stuck in an old state).

### Opacity (WEB-13)

Joined with `asymmetric-2nodes.glb`, **Structures** open.

1. Drag the tumour's slider to 100 % (the fixture's tumour is translucent), then the liver's thumb to about 40 %, and
   rotate. **Expect:** the liver turns translucent while you drag; the tumour inside is solid and fully visible, with
   no flicker or cut-outs while rotating (the opaque node is still depth-sorted, US-10).
2. Tap the track away from the thumb. **Expect:** on iPhone nothing (Safari moves a range input only by its thumb,
   which is easy to hit: 44 px); on Android the thumb jumps there.
3. Swipe up and down over the sliders, starting on the thumb and on the track away from it. **Expect:** the list
   scrolls; the opacities do not change (on Android the thumb may flick to the finger and straight back).
4. With VoiceOver / TalkBack, move to a slider. **Expect:** "Opacity of Liver, 100 %" (Polish: "Krycie: …"); swipe
   up/down changes it in 1 % steps.
5. With `colour-cycle` playing, set the tumour's slider yourself. **Expect:** at the presenter's next change the
   slider jumps to the presenter's value and "The presenter changed Tumor" shows at the top for about 3 s.
6. Hide the liver yourself while `colour-cycle` plays. **Expect:** its colour changes are applied (seen when you
   show it again) but it stays hidden.

### Reconnect (WEB-14)

Joined with `toggle-visibility --loop` playing.

1. Switch on airplane mode for 10 s, then off. **Expect:** "Reconnecting…" over the scene while offline (the scene
   and your camera stay); a few seconds after the network returns the status goes and the switches follow the
   presenter again — no Join, no new download (Web Inspector → Network shows no second `/api/scene`).
2. Lock the phone for 2 minutes, unlock. **Expect:** the same as step 1, within about 10 s of unlocking.
3. Take the presenter's laptop off the network for 30 s, then back (Slicer resumes within the 120 s grace).
   **Expect:** "Presenter is offline" over the frozen scene while it is away; it goes when the presenter is back.
4. Restart or redeploy the relay while joined. **Expect:** "Reconnecting…", then "Waiting for the presenter" (or
   "Loading the scene…" if the presenter has shared it again already) under Join (cells disabled), then the scene
   again — about 5–10 s, nothing typed.
5. The presenter stops the session. **Expect:** "Presentation ended" on the code entry, the code still in the
   cells; nothing retries.
6. Lock the phone, let the presenter stop the session, unlock after a minute. **Expect:** "Reconnecting…" for up to
   a minute, then "Presentation ended" on the code entry (not "Code not recognised").
7. With VoiceOver on, repeat step 1. **Expect:** "Reconnecting…" is spoken once, then "Connected again".

### Download in the background (WEB-06 review, WEB-10)

1. Join with `large-synthetic.glb` on a slow network (Settings → Developer → Network Link Conditioner "3G"), and
   switch to another app while it downloads; return after 5 s. **Expect:** the download completes or restarts
   once; no "stalled" error right after returning.

## Android Chrome

Devices: a current Chrome and the previous major (NFR-26). Run the **iPhone Safari** steps above with these
differences:

- Deep link step 1: scan with the stock camera or Google Lens (`[TODO verify]` per device, research web.md §4);
  the link must open in Chrome, not in an in-app browser.
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
