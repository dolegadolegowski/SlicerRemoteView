# ADR 0010: The Slicer extension's top level at the repository root

- **Status:** Accepted (2026-11-03, `slicer` workstream, SLC-72; on `main` once `release` merges it)
- **Component(s):** `slicer` (the root `CMakeLists.txt` is its file), `release` (the component map in `CLAUDE.md`,
  the repository's settings)
- **Related:** `docs/plan/slicer.md` (SLC-20, SLC-72), `docs/research/slicer-extensions-index.md` (the facts below,
  with line references), `docs/research/slicer-packaging.md` §4 (the blockers), `docs/release/extensions-index.md`
  (the submission checklist), ADR 0007 (monorepo wiring)

## Context

The 3D Slicer extension `RemoteView` (one scripted module) lives in `slicer-plugin/` of this monorepo. Until SLC-72
its top-level `CMakeLists.txt` (`project(RemoteView)`, the `EXTENSION_*` metadata) was `slicer-plugin/CMakeLists.txt`.
Verified facts (research note §1–§4):

- The Extensions Index CI clones `scm_url`, checks out `scm_revision` and reads the clone's **root**: the first
  `project(` text of the root `CMakeLists.txt` (comments included) must equal the catalog entry's base name;
  `EXTENSION_ICONURL` and `EXTENSION_SCREENSHOTURLS` are read there with regular expressions (CMake is not run) and
  each URL must serve an image; a licence file (`LICENSE`, `LICENSE.txt`, …) must be at the root; the checkout,
  `.git` included, may not exceed 100 MB.
- The pull-request packaging test (Windows, Linux) configures, builds and `cpack`s the clone's root against a stand-in
  Slicer build tree, without setting `<Name>_BUILD_SLICER_EXTENSION`; the Slicer factory configures the same root
  with it `ON`, then packages, uploads and tests, every day for Stable and every night for Preview.
- Slicer 5.12.4's CMake: `EXTENSION_NAME` is `PROJECT_NAME` at `include(${Slicer_USE_FILE})`; `SlicerExtensionCPack`
  packages only where `EXTENSION_NAME` equals `PROJECT_NAME`, and names the package and the generated description
  after the git revision of `CMAKE_SOURCE_DIR` — a source directory without `.git` is recorded as `local`, revision
  `NA`. A scripted module's files resolve against its own directory, whatever its depth.
- On `main` before SLC-72 the root does not configure at all, and `slicer-plugin/` configured on its own records
  "not a GIT checkout" (§5 of the research note: a `cmake` run with a stub Slicer written for the check).
- The repository is 18.7 MB as a full clone and holds no C++ (`*.cxx`, `*.h`), so the packaging test runs. It is
  private; making it public and adding the topic `3d-slicer-extension` is the owner's decision, outside this ADR.

## Decision

1. The repository root's `CMakeLists.txt` is the extension's top level, as in the Slicer 5.12.4 extension template and
   in its order: `cmake_minimum_required`, `project(RemoteView)` (the first `project(` text in the file), the
   `EXTENSION_*` metadata, `find_package(Slicer REQUIRED)`, `include(${Slicer_USE_FILE})`,
   `add_subdirectory(slicer-plugin)`, `include(${Slicer_EXTENSION_GENERATE_CONFIG})`,
   `include(${Slicer_EXTENSION_CPACK})`. Nothing is conditional: the packaging test and the factory configure the same
   thing.
2. It holds the only copy of the metadata. `slicer-plugin/CMakeLists.txt` only adds the extension's modules
   (`add_subdirectory(RemoteView)`) and stops with a message when configured on its own. The catalog entry
   `slicer-plugin/RemoteView.json`, the module's `parent.contributors`, the release zip's name (`scripts/package.py`)
   and the tests follow the root file; `tests/test_package.py` also reads it with the index CI's expressions.
3. `EXTENSION_CONTRIBUTORS` is `Damian Dołęga-Dołęgowski (SlicerRemoteView)` (*Firstname Lastname (Organization)*).
   `EXTENSION_HOMEPAGE` is `…/SlicerRemoteView/tree/main/slicer-plugin`, the extension's README (name, description,
   screenshot, licence, data flow), because the repository's front page describes the whole system in Polish;
   `scm_url` stays the repository's `.git` URL.
4. The root `LICENSE` (MIT) is the licence file; no `LICENSE.txt` copy (the index accepts both names).
5. The catalog entry uses `scm_revision` `main` on both index branches (`main` → Preview, `5.12` → Stable), as 252 of
   the 259 Stable entries do with `main` or `master` — and as the project's relay, which follows `main` too
   (`docs/deploy.md` §8), so the module users get and the relay it meets move together. A Slicer-version branch in
   this repository (e.g. `5.12`) is made only when `main` stops working with Slicer 5.12; the `5.12` entry then
   names it.
6. The root `CMakeLists.txt` is a `slicer` file (it changes with `slicer-plugin/`); `release` adds it to the
   component map of `CLAUDE.md`.

## Consequences

**Positive:** the repository passes the index's checks that can run before submission; the metadata has one copy and
the tests fail on drift; package names and descriptions carry the git revision; the pull-request test and the factory
build the same top level; the release zip and *Additional module paths* installs are unchanged.

**Negative:** a root file that only the Slicer extension uses. With `main` in the index, every commit on `main` that
changes `slicer-plugin/RemoteView/` reaches Slicer users within a day — the catalog has no release gate, and the tag
and `__version__` name the GitHub release only. The index's tools see the whole monorepo: the AI analysis reads every
`*.py` and `*.md` — 2.4 M characters of Markdown and 1.9 M of Python today, about 77 model calls, which may not fit
its 60 minutes (30 on `5.12`) `[TODO verify]` — the 100 MB limit counts the whole history, and a C++ file added
anywhere (e.g. a native plugin header under `quest-app/`) would make the pull-request packaging test skip silently.
The repository's own CI runs the extension's tests only for changes under its watched paths, which do not include the
root `CMakeLists.txt` and `LICENSE` (`.github/scripts/detect-changes.mjs`, report `2026-11-03-slicer-1`).

**Follow-ups:** owner — make the repository public, add the topic, open the two pull requests
(`docs/release/extensions-index.md`). `release` — the component map and the ADR index; the user guides' install
chapters once the extension is listed; `prompts/04-slicer-plugin.md` still names `slicer-plugin/CMakeLists.txt` for
the metadata; `docs/README.md` for `docs/release/`. `deploy` — the `python_slicer` job's paths gain the root
`CMakeLists.txt` and `LICENSE` (report `2026-11-03-slicer-1`). `server` — the root `CMakeLists.txt` in
`.dockerignore` (ADR 0007 §5): the relay's build stage gets it through `COPY . .`, harmless but a cache miss when it
changes. `slicer` — `docs/testing/slicer.md` §17 after the first factory build.

## Alternatives considered

- **A separate extension repository** (move `slicer-plugin/` out): a clean view for the index, but it splits the
  vendored protocol (ADR 0007 §3), the CI, the plan and the releases; rejected while one team owns everything.
- **The root adds `slicer-plugin` only under `RemoteView_BUILD_SLICER_EXTENSION`** (NVIDIA's precedent): the
  pull-request packaging test does not set it and would package nothing; rejected.
- **The metadata stays in `slicer-plugin/CMakeLists.txt` and the root `include()`s it:** the index CI reads only the
  root file, as text, so `project()` and both URL lines must be literal there anyway; two copies drift; rejected.
- **The root adds `slicer-plugin/RemoteView` and `slicer-plugin/CMakeLists.txt` goes:** one file less, but the
  module list moves into a root file; rejected for ownership (Decision 6).
- **`build_subdirectory` `slicer-plugin`:** it names a superbuild's inner build directory, not a source directory
  (`slicer-packaging.md` §4); rejected.
- **`scm_revision` a `release` branch moved at each tag:** gates the catalog behind releases, at the cost of one more
  step per release and against the index's convention; deferred — the checklist says how to switch.

## Sources

- https://github.com/Slicer/ExtensionsIndex/blob/a29e47363096eafe4bd2c56d09ac581c9c381a39/scripts/check_description_files.py
- https://github.com/Slicer/ExtensionsIndex/tree/a29e47363096eafe4bd2c56d09ac581c9c381a39/.github/workflows
- https://github.com/lassoan/Slicer/blob/ca6a92aebf5beeb25a196be24dd79b452227404c/Utilities/Scripts/package_python_extension.py
- https://github.com/Slicer/Slicer/tree/v5.12.4/Extensions/CMake and https://github.com/Slicer/Slicer/tree/v5.12.4/CMake
- https://github.com/Slicer/Slicer/blob/v5.12.4/Utilities/Templates/Extensions/Default/CMakeLists.txt
- https://github.com/Slicer/Slicer/blob/v5.12.4/Docs/developer_guide/extensions.md
