# Changelog

All notable changes to SlicerRemoteView. The section of a version is the text of its GitHub release
(`.github/workflows/release.yml` reads it). Dates are ISO (YYYY-MM-DD).

## [Unreleased]

- The Slicer extension is named **RemoteView**, as the Extensions Index requires (names starting with "Slicer"
  are refused): `project(RemoteView)` in the extension's top-level `CMakeLists.txt`, the catalog entry
  `RemoteView.json`, and the release zip `RemoteView-<version>.zip` holding the folder
  `RemoteView-<version>/RemoteView`. The project, the repository, the relay and the protocol identifiers keep
  the name SlicerRemoteView; the module is `RemoteView` as before.
- Groundwork for installing RemoteView from Slicer's Extensions Manager: the extension's top-level
  `CMakeLists.txt` is now at the repository root, where the Slicer Extensions Index and Slicer's extension
  builds look for it, and it names its contributor, Damian Dołęga-Dołęgowski. Until the extension is listed,
  install it from the release zip; the submission steps are in `docs/release/extensions-index.md`.

## [0.1.0] - 2026-11-03

The first release: the 3D Slicer module, the relay server and the web viewer, as used by the project's own
testers since October 2026.

### RemoteView module for 3D Slicer 5.12

- **Share the 3D view in one click.** *Start session* sends the models and segments shown in the 3D view to
  a relay server and shows a 5-character code and a QR code; phones, tablets and Meta Quest headsets join
  with them. A *Presentation window* shows both in large print for a projector; *Copy link* copies the join
  link.
- **Live.** Changes in Slicer — colour, opacity, visibility, transforms, meshes, segments edited, models
  added, renamed or removed, a scene opened or closed — reach the viewers while the session runs. A toolbar
  on Slicer's main window chooses when they go: at once, 15, 30 or 60 s after the last change (30 s by
  default, with a countdown on *Send scene now*), or only when you click *Send scene now*.
- **Slicer stays responsive.** Large scenes are simplified for the devices in steps between Slicer's own
  events, with a cache per model, so editing goes on while the scene is prepared.
- **Small islands.** *Remove small islands* (on by default) leaves out small pieces not connected to the
  rest of a model or segment before the scene is reduced for sending.
- **Sessions survive a lost connection.** The module reconnects and resumes the same session and code after
  a dropped network link or a relay restart.
- **Privacy by design.** Nothing leaves the computer before *Start session*; the panel names the relay that
  will receive the scene; the connection is encrypted (`wss://`); session codes and tokens never appear in
  URLs or logs; the relay keeps the scene in memory only.
- Installation from the release zip (`RemoteView-<version>/RemoteView` as an additional module path);
  the two Python packages the module needs are installed on the first *Start session*, after asking.

### Relay server

- Node.js 22, Fastify and WebSockets; sessions in memory only, one replica; codes that expire and cannot be
  guessed (rate limits and bans per address); per-socket message budgets; a 12-hour session limit and a
  30-minute idle limit; graceful draining on redeploy; `/healthz` with open sessions and viewers.
- Docker image (`relay-server/Dockerfile`) and a Railway setup described in the user guide; configuration as
  code in `.railway/`.

### Web viewer

- Vite and three.js; joins with a code or a link, in Polish or English; keeps the camera when a new version of
  the scene arrives; works in the Meta Quest browser.

### Project

- Protocol 1.1 (`docs/protocol.md`) with JSON schemas shared by all components.
- CI on GitHub Actions (lint, type checks, unit tests, Docker build, end-to-end, security and load tests),
  Dependabot, a release workflow on version tags.
- User guides in Polish and English: installing the module, running your own relay.
