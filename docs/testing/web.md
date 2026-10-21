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

### Language (WEB-21)

1. With the iPhone set to English, open the viewer. **Expect:** English texts and a **Polski** button at the top
   right of the code entry. Turn VoiceOver on and swipe to it. **Expect:** "Polski, button" read with Polish
   pronunciation.
2. Tap **Polski**. **Expect:** at once, without a reload: the title, the hint under the cells, Join and the button
   (now **English**) in Polish; a shown error message follows too.
3. Join, then tap **English** in the status bar and back to **Polski**. **Expect:** the bar, the node panel, the
   notice line and the Fit button follow at once; the scene, the camera and the session stay (no rejoin, the viewer
   count on the presenter does not change).
4. Close the tab and open the viewer again. **Expect:** Polish from the start. Settings → Safari → Advanced →
   Website Data (iOS 18: Settings → Apps → Safari → Advanced → Website Data) lists the site, and Web Inspector
   (Mac) → Storage → Local Storage shows only the key `rv.lang`.
5. Private Browsing tab: tap **Polski**. **Expect:** it switches (the choice may be forgotten when the tab closes).

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
    then "Connected" in the status bar, with the same camera and nothing typed (WEB-14, WEB-15). Note which one
    happened.

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

1. Switch on airplane mode for 10 s, then off. **Expect:** "Reconnecting…" in the status bar while offline (the
   scene and your camera stay); a few seconds after the network returns the bar shows the green "Connected" again
   and the switches follow the presenter — no Join, no new download (Web Inspector → Network shows no second
   `/api/scene`).
2. Lock the phone for 2 minutes, unlock. **Expect:** the same as step 1, within about 10 s of unlocking.
3. Take the presenter's laptop off the network for 30 s, then back (Slicer resumes within the 120 s grace).
   **Expect:** "Presenter is offline" in the status bar over the frozen scene while it is away, "Connected" when
   the presenter is back.
4. Restart or redeploy the relay while joined. **Expect:** "Reconnecting…", then "Waiting for the presenter" (or
   "Loading the scene…" if the presenter has shared it again already) under Join (cells disabled), then the scene
   again — about 5–10 s, nothing typed.
5. The presenter stops the session. **Expect:** "Presentation ended" on the code entry, the code still in the
   cells; nothing retries.
6. Lock the phone, let the presenter stop the session, unlock after a minute. **Expect:** "Reconnecting…" for up to
   a minute, then "Presentation ended" on the code entry (not "Code not recognised").
7. With VoiceOver on, repeat step 1. **Expect:** "Reconnecting…" is spoken once, then "Connected" (status bar).

### Status bar (WEB-15)

1. Join. **Expect:** at the top, below the notch / Dynamic Island and inside the rounded corners (portrait and
   landscape; attach both screenshots to **Results**): a green dot, "Connected", "Viewers: n" and "Scene v<n>" with
   the presenter's current scene version (also when changes were made after the snapshot).
2. Join from a second phone. **Expect:** the count goes up on both at once; it goes down when one leaves.
3. Play `toggle-visibility`. **Expect:** the scene version goes up with every change.
4. Airplane mode for 10 s. **Expect:** the dot turns amber and "Reconnecting…", then green "Connected" again;
   VoiceOver speaks both.
5. Tap **Leave** at the end of the bar (WEB-22), also with a fingertip just above or below the pill. **Expect:** the
   empty code entry with the keyboard on the first cell; the presenter's viewer count drops by one at once. Join
   again with the same code: the scene comes back.
6. Join `large-synthetic.glb` under Network Link Conditioner "3G" (as in §Download in the background) and tap
   **Leave session** under Join while it says "Loading the scene…". **Expect:** as in step 5, and the download stops.
   Repeat right after a relay restart while it says "Waiting for the presenter" (§Reconnect step 4), and before the
   scene is shown during "Reconnecting…" (airplane mode on, tap, airplane mode off): no join happens by itself
   afterwards.

### Memory and wake lock (WEB-16)

1. Save `[{"afterMs":5000,"type":"scene.snapshot"}]` as `resend.json` (a `scene.snapshot` entry without `fixture`
   resends the `--fixture` GLB) and start `node_modules/.bin/fake-slicer --relay wss://<host>/ws --fixture
   large-synthetic.glb --script ./resend.json --loop --code-fd 3 3>code.txt`. Join and let it resend three times.
   After each new scene type `__rv.rendererInfo()` in the remote console (Safari Web Inspector; on Android
   `chrome://inspect`). **Expect:** `geometries` equals the fixture's node count every time; no "3D view paused",
   no reload of the tab; Web Inspector → Timelines → Memory stays flat (R-02).
2. Join by typing the code and leave the phone untouched on the desk for longer than its auto-lock time.
   **Expect:** the screen stays on while the session runs; after "Presentation ended" it dims as usual (FR-46).
   Then join from a QR link and touch the scene once: Safari grants the lock only after a tap (WebKit
   `WakeLock.cpp`). **Expect:** from then on the screen stays on, also after switching apps and back.
3. Switch to another app for 10 s and back, then wait again. **Expect:** the screen still stays on (the lock is
   requested again).
4. Open many other tabs with heavy pages until Safari reclaims memory, then come back. **Expect** one of: the scene
   as before; "3D view paused" and then the scene again by itself; or the tab reloaded to an empty code entry
   (Safari discarded the page, R-02 — record it). Never a black canvas without a message.
5. In the remote console run `x = document.querySelector(".viewer__canvas").getContext("webgl2")
   .getExtension("WEBGL_lose_context"); x.loseContext()`. **Expect:** "3D view paused" without a Dismiss button
   (VoiceOver reads it). Then `x.restoreContext()`. **Expect:** the same scene and camera again, the message gone.
6. Turn on airplane mode for more than 2 minutes with the scene open. **Expect:** "Reconnecting…", and the screen
   may dim after its usual timeout (the lock is let go offline); back online, the scene and the lock return.

### Add to Home Screen (WEB-17)

1. Safari → Share → **Add to Home Screen**. **Expect:** the cube icon (not a screenshot of the page) and the name
   "Remote View".
2. Open it from the Home Screen. **Expect:** no Safari bars; the page is under the status bar without overlap
   (the clock and battery stay readable over the dark background); join and view work as in Safari.
3. Open a QR link while the app is installed. **Expect:** it opens in Safari or in the app (either is fine,
   `[TODO verify]` research web.md §2.6), the code is joined and the address bar (if any) shows `/j`.
4. Android Chrome: menu → **Install app** (or **Add to Home screen**). **Expect:** the cube icon, shaped by the
   launcher (maskable), and the app opens without browser UI.
5. In the installed app (no address bar, no reload; on iOS no back button): during a session tap **Leave** in the
   status bar, and **Leave session** on the code entry while the scene is loading (as in §Status bar step 6)
   (WEB-22). **Expect:** the empty code entry each time; a different code can be joined. Then close the app from the app switcher during a
   session. **Expect:** next launch starts on the code entry (`start_url` `/`), and the presenter's viewer count
   drops by one within 60 s (at once with `pagehide` → `viewer.leave`, §5.4; else the relay's WS-ping timeout, §9.1).
   Android: also press the system Back during a session and record what happens (expected: the app closes;
   `[TODO verify]`).

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

WebXR entry (WEB-19) below; grabbing, scaling and the Quest 2 budget warning follow with WEB-20 (NFR-27).

### Device profile (WEB-15)

On Quest 2, Quest 3, Quest 3S (and Quest Pro if available), current Meta Quest Browser:

Quest Browser has no developer tools on the headset: connect it over USB (developer mode) and inspect the tab from
`chrome://inspect` on a computer.

1. Open `https://<host>/` and record, in desktop mode and in mobile mode, `navigator.userAgent`,
   `navigator.userAgentData?.brands`, `.platform`, `.mobile` and
   `await navigator.userAgentData?.getHighEntropyValues(["model", "platformVersion"])`. **Expect:** `OculusBrowser/`
   and a `Quest …` token in both modes (research `docs/research/web-quest-user-agent.md` §1.3, §2, §3 — note
   anything else there). Add each recorded user agent to the matrix in `web-viewer/test/platform.test.ts`.
2. Join a session and, in DevTools → Network → WS → Messages, open the first frame (`viewer.join`). **Expect:**
   `clientInfo.platform` `quest-browser`, `profile` `quest3` on Quest 3 / 3S and `quest2` on the others,
   `capabilities.maxSnapshotBytes` 67108864 on Quest 3 / 3S (33554432 otherwise), and no user agent anywhere in the
   frame. (`viewer.count.platforms` and the publisher's viewer list show only `quest-browser`, once SRV-07 and
   SLC-18 exist.)
3. On a Quest 3, load a scene close to 64 MiB (`[TODO verify]`: Quest Browser tab memory, NFR-03). **Expect:** it
   loads and stays responsive; if the tab is killed, record it — the limit for `quest3` goes back to 32 MiB.

### WebXR (WEB-19)

On Quest 2 and Quest 3 (3S if available), current Meta Quest Browser, the viewer deployed behind the relay (its CSP
matters: the controller models' textures must load under it). Bring a tape measure. Reference size in
`asymmetric-2nodes.glb`: the opaque tetrahedron has vertices at glTF (+0.1, 0, 0) and (0, 0, −0.1) m — each 100 mm from
its corner at the origin, and the edge between them ≈ 141 mm (`shared/fixtures/glb/manifest.json`, protocol §7.1).

1. Join a session. **Expect:** **View in AR** at the bottom centre on Quest 3 (passthrough); on Quest 2 **View in
   AR** too if Quest Browser offers `immersive-ar` there (greyscale passthrough), else **View in VR** — record which
   (`[TODO verify]` ADR 0003). Switch the language: **Zobacz w AR/VR**.
2. Press it. **Expect:** the immersive view starts without a prompt about anything but the headset's own; the scene
   stands about 1.3 m in front of you at eye height, at real size (measure the tetrahedron's ≈ 141 mm edge: 1 mm in
   Slicer = 1 mm in the room); AR shows the room behind it, VR a dark background.
3. Look at your controllers, then put them down and show your hands. **Expect:** the matching controller models
   (Quest 3: Touch Plus; Quest 2: Touch) with their textures, then hand meshes following your fingers. In
   `chrome://inspect` → Network: every request goes to the relay's origin, the models under
   `/assets/xr-profiles-1.0.20/`; no `cdn.jsdelivr.net`; Console: no "Couldn't load texture".
4. While in XR, let the presenter hide a structure (`toggle-visibility`). **Expect:** it disappears in the headset
   within 0.5 s (NFR-02).
5. Walk around the scene and look at it from behind and from below. **Expect:** it stays where it was put; no
   clipping when your head is 5 cm from a surface.
6. Leave XR with the Meta button → **Exit**. **Expect:** the 2D page as it was before (same camera view, node
   panel, status bar); pinch, rotate and Fit work. Enter again and let the presenter share the scene again
   (snapshot v2) while you are in XR, then exit. **Expect:** the 2D view framed from the front as after any new scene
   (not zoomed in).
7. Enter XR and let the presenter end the session. **Expect:** the immersive view closes by itself and the code
   entry says "Presentation ended".
8. Enter XR again, then take the headset off for 10 s and put it back on. **Expect:** the session resumes or ends
   cleanly; either way the 2D page works afterwards.
9. Quest Browser performance HUD (developer settings) during step 2 with `asymmetric-2nodes.glb`: record the frame
   rate (72 Hz expected, NFR-07).
10. Grab (WEB-20) with a controller's trigger: move and turn your hand. **Expect:** the scene follows it rigidly and
    stays when you let go. Then both triggers: pull your hands apart and together, turn the line between them.
    **Expect:** the scene scales about the point between your hands, never below 0.1× or above 5× of real size, and
    turns about the vertical with the line (it stays upright, also through a half turn). Repeat with your hands (pinch
    instead of trigger), and twist the pinching wrist: **Expect:** the scene turns with the wrist (`[TODO verify]`:
    research web-xr.md §1). Move one hand out of view during a two-hand grab: **Expect:** no jump, then or when it
    comes back.
11. Walk a step aside and turn, then press a controller's grip button, then pinch twice quickly with one hand.
    **Expect:** each time the scene goes back exactly where it was first placed — 1.3 m ahead of where you stood when
    XR started, at your current eye height, real size, unturned — and the second pinch does not drag it.
12. On Quest 2 join `large-synthetic.glb` (above 500 k triangles), enter XR. **Expect:** a panel below the scene:
    "This scene is above the Quest 2 budget …" (Polish when the UI is Polish), gone after about 10 s. A small scene
    shared with the `mobile` profile: "This scene was not prepared for Quest 2 …". On Quest 3 neither shows a panel.
13. Performance HUD with `asymmetric-2nodes.glb` and with the `quest2` budget fixture on Quest 2, while grabbing:
    **Expect:** 72 Hz sustained (NFR-07); record the values in **Results**.

## Results

| Date | Tester | Device / OS | Browser + version | Build (git SHA) | Sections | Result / notes |
|------|--------|-------------|-------------------|-----------------|----------|----------------|
|      |        |             |                   |                 |          |                |
