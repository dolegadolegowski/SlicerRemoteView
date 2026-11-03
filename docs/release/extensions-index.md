# Submitting RemoteView to the Slicer Extensions Index

The steps that put the `RemoteView` extension into Slicer's Extensions Manager. The repository side is done
(SLC-72, [ADR 0010](../adr/0010-slicer-extension-top-level-at-repository-root.md)): the root `CMakeLists.txt`
is the extension's top level, the catalog entry is
[`slicer-plugin/RemoteView.json`](../../slicer-plugin/RemoteView.json), and
`slicer-plugin/tests/test_package.py` runs the index's checks on the CMake file that can run offline. What is
left needs the owner: the repository's visibility, its topic and the pull requests. Facts and line references:
[`docs/research/slicer-extensions-index.md`](../research/slicer-extensions-index.md).

## 1. Before you start

- [ ] `main` holds the root `CMakeLists.txt` (`ws/slicer-extensions-index` merged): the index clones `main`.
- [ ] The checks pass on `main`: in `slicer-plugin/`, `pytest -k "package or skeleton"` (see its README).
- [ ] Optional — the index's packaging test on your machine (Python 3, CMake ≥ 3.31: its stand-in sets policy
      CMP0177; from the repository root). It runs code from Andras Lasso's `python-ext-build` branch of
      Slicer, as the index CI does (there on Windows and Linux); give it absolute paths, as the CI does:

```bash
git clone --depth 1 --branch python-ext-build https://github.com/lassoan/Slicer.git ../slicer-python-ext-build
```

```bash
python ../slicer-python-ext-build/Utilities/Scripts/package_python_extension.py --ext-src "$PWD" --slicer-src "$PWD/../slicer-python-ext-build" --build-dir "$PWD/../ext-build" --dummy-build "$PWD/../SlicerDummyBuild" --output-dir "$PWD/../ext-packages" --slicer-revision python-ext-build --cmake-arg=-DBUILD_TESTING=OFF
```

  Expected: a `python-ext-build-<os>-<arch>-RemoteView-git<revision>-<date>` archive in `../ext-packages`
  whose `lib/Slicer-5.11/qt-scripted-modules/` holds `RemoteView.py`, `remoteview_core/`, `_vendor/` and
  `Resources/` (the branch reports Slicer 5.11). Not run by SLC-72 `[TODO verify]`.

## 2. Make the repository public (owner's decision)

Everything becomes public: the history, the issues, the Actions logs, the releases, `.railway/` and the deploy
notes. Nothing in the repository is meant to be secret (CLAUDE.md rule 6), but look before you switch:

- [ ] No secret in the current tree: `node .github/scripts/scan-secrets.mjs` (DEP-05) exits 0.
- [ ] None in the history either — every added or removed line that looks like one of the project's secrets or
      a well-known key format, then every file name that looks like a key or an `.env` file:

```bash
git log --all -p -G '(METRICS|RAILWAY(_API)?)_TOKEN *[=:]|PRIVATE KEY|ghp_|github_pat_|AKIA' | grep -E '^[+-].*((METRICS|RAILWAY(_API)?)_TOKEN *[=:]|PRIVATE KEY|ghp_|github_pat_|AKIA)'
```

```bash
git log --all --name-only --format= | sort -u | grep -E '(^|/)\.env|\.(pem|key|p12|jks)$'
```

  On 2026-11-03 the first printed 26 lines — test fixtures, the scanner's own patterns and empty placeholders
  — and the second only `relay-server/.env.example`; anything new needs a look before the switch (a real
  secret: rotate it first). GitHub's secret scanning also runs once the repository is public.
- [ ] *Settings → General → Danger Zone → Change repository visibility → Make public.*
- [ ] Hide the features the project does not use (template item). On 2026-11-03 (`gh repo view`) *Projects*
      was on — turn it off unless used (*Settings → General → Features*) — and *Wiki* and *Discussions* were
      off. Keep *Releases* shown in *About ⚙* (the release zip lives there); untick *Packages* unless the
      relay image on GHCR should be listed.

## 3. Add the topic

- [ ] Main page → *About ⚙ → Topics* → `3d-slicer-extension` → *Save changes*, or:

```bash
gh repo edit dolegadolegowski/SlicerRemoteView --add-topic 3d-slicer-extension
```

- [ ] The index CI reads the topic through the API; this should list it:

```bash
gh api repos/dolegadolegowski/SlicerRemoteView/topics
```

## 4. Check what the index downloads

All three must work without signing in (a private window), from `main`:

- [ ] Icon:
      <https://raw.githubusercontent.com/dolegadolegowski/SlicerRemoteView/main/slicer-plugin/RemoteView/Resources/Icons/RemoteView.png>
- [ ] Screenshot:
      <https://raw.githubusercontent.com/dolegadolegowski/SlicerRemoteView/main/slicer-plugin/Screenshots/RemoteView-panel.png>
- [ ] Homepage: <https://github.com/dolegadolegowski/SlicerRemoteView/tree/main/slicer-plugin> — the README
      with the name, description, screenshot, licence (MIT) and data flow.

## 5. Fork the index and open the pull requests

> Submitted on 2026-11-03 from the fork `dolegadolegowski/ExtensionsIndex`:
> [Slicer/ExtensionsIndex#2438](https://github.com/Slicer/ExtensionsIndex/pull/2438) (`main`, Preview) and
> [Slicer/ExtensionsIndex#2439](https://github.com/Slicer/ExtensionsIndex/pull/2439) (`5.12`, Stable). Steps 2–3 were
> done the same day (public repository, topic, Projects off).

One file, `RemoteView.json` at the root of the index, byte for byte the repository's copy (LF line endings,
`scm_revision` `main`). Two pull requests: `main` serves the Slicer Preview Release, `5.12` the 5.12 Stable
Release.

```bash
gh repo fork Slicer/ExtensionsIndex --clone && cd ExtensionsIndex && git fetch upstream
```

```bash
git switch -c add-RemoteView upstream/main && cp ../SlicerRemoteView/slicer-plugin/RemoteView.json . && git add RemoteView.json && git commit -m "ENH: Add RemoteView extension" && git push -u origin add-RemoteView
```

```bash
git switch -c add-RemoteView-5.12 upstream/5.12 && cp ../SlicerRemoteView/slicer-plugin/RemoteView.json . && git add RemoteView.json && git commit -m "ENH: Add RemoteView extension (5.12)" && git push -u origin add-RemoteView-5.12
```

(`gh repo fork --clone` names the original `upstream`; adjust `../SlicerRemoteView` to your checkout.) Open
the first with `gh pr create --repo Slicer/ExtensionsIndex --base main --head <you>:add-RemoteView --web` (the
browser shows the template), the second with `--base 5.12 --head <you>:add-RemoteView-5.12`. The Stable one
can wait until the Preview one has been reviewed.

## 6. The pull-request text

Keep the template's *New extension* section and tick the Tier 1 items; all hold once steps 2–4 are done. Items
that need a word:

- *LICENSE.txt is present in the repository root*: the file is `LICENSE` (MIT), one of the names the index CI
  accepts; the homepage names the licence.
- *Any known related patents*: none known.
- *Homepage: publication*: none yet.
- *Does not send any information anywhere without user consent*: holds — explicit opt-in, see below.

For the comment section at the end:

> RemoteView shares the 3D view with phones, tablets and Meta Quest headsets through a relay server that the
> user chooses. The repository is a monorepo: the extension's top-level `CMakeLists.txt` is at the root, its
> one scripted module in `slicer-plugin/RemoteView`; the rest is the relay server and the web viewer the
> module talks to, so reviewing the extension means reading `slicer-plugin/` (the AI analysis reads all of it,
> about 4 M characters). Nothing is sent and nothing is installed before the user clicks *Start session*: the
> first click asks before `pip` installs `websockets` and `segno` from PyPI (exact versions; neither is
> bundled with Slicer), then the module sends the surface meshes shown in 3D and their display properties to
> the relay address the user typed, over TLS. What leaves the computer is listed in the README and in the
> module's help text. MIT licence.

## 7. What the index CI checks

| Workflow | What it does | Where to read it |
|---|---|---|
| *Extension Validation* | clones `scm_url` at `scm_revision` without credentials; checkout ≤ 100 MB with `.git` (ours ≈ 19 MB); JSON against its schema, LF endings; the name does not start with `Slicer`; category known; repository name starts with `Slicer`; topic `3d-slicer-extension`; the root `CMakeLists.txt`: first `project(` is `RemoteView`, the icon and screenshot lines are found and each URL serves an image; a licence file at the root | the run's *Summary* (a fork's pull request gets no comment) |
| *Lint* | `pre-commit` on the pull request's files: LF endings, final newline, no tabs or trailing spaces, `prettier` formatting of the JSON, the JSON against the index's copy of schema v1.0.2 | the job's log |
| *Package Python Extension* | on Windows and Linux: clone, then configure, build and `cpack` the root as in step 1 | artifacts `package-RemoteView-Windows` and `-Linux` |
| *Extension AI Analysis* | a language model answers twelve questions (eleven on `5.12`) about the `*.py`, `*.md` and `CMakeLists.txt` files (uploads, downloads, code at import, pinned packages); this monorepo makes about 77 calls, which may not fit its 60 minutes (30 on `5.12`) `[TODO verify]` | the run's *Summary*, written only when it finishes; a failed clone turns it red |

A red *Extension Validation* before step 2 or 3 is expected (clone or topic). On the `5.12` pull request the
topic check calls GitHub's API without a token; a `ValueError: Failed to get github topics …` with status 403
or 429 in its log is a rate limit — re-run the job. After a fix in this repository, push to `main` and re-run
the failed jobs: the entry names a branch, so the pull request needs no change.

## 8. After the merge: the factory and CDash

The Slicer factory builds every entry from its `scm_url` and `scm_revision`: the `5.12` entries during the day
for the Stable Release, the `main` entries every night for the Preview Release; a package is uploaded even
when tests fail. Find RemoteView's builds (the build name contains the extension's name):

- Preview:
  <https://slicer.cdash.org/index.php?project=SlicerPreview&filtercount=1&showfilters=1&field1=buildname&compare1=63&value1=RemoteView>
- Stable:
  <https://slicer.cdash.org/index.php?project=SlicerStable&filtercount=1&showfilters=1&field1=buildname&compare1=63&value1=RemoteView>

- [ ] The day after each merge: configure, build and test are green on Windows, macOS and Linux; a red number
      links to the log. The tests are the module's generic tests (`WITH_GENERIC_TESTS`), run in Slicer.
- [ ] Then install it from the Extensions Manager and run `docs/testing/slicer.md` §17.
- [ ] `release`: the install chapters of the user guides (`docs/user-guide/*/install-plugin.md`) gain the
      Extensions Manager.

## 9. Releasing a new version afterwards

- The catalog follows `main`: every factory build packages the `main` of that day and Slicer offers it as an
  update. The catalog has no version field and no pull request is needed per version. Keep `main` installable
  at all times, and keep the icon and screenshot at their paths: the catalog loads them from `main`.
- A versioned release (the zip on GitHub Releases) is as before: set `__version__` in
  `slicer-plugin/RemoteView/remoteview_core/__init__.py` on `main` (the only place), add the CHANGELOG
  section, tag `vX.Y.Z` and push the tag; `release.yml` builds the zip only if the tag equals `__version__`;
  publish the draft (`docs/deploy.md` §8).
- If `main` stops working with Slicer 5.12: create a branch `5.12` in this repository at the last commit that
  works with it and change the index's `5.12` entry to `"scm_revision": "5.12"` (a small pull request to that
  branch).
- To ship to Slicer users only at releases instead (ADR 0010 alternative): create a branch `release` at the
  latest tag, change `scm_revision` to `release` in both index branches, and at each release fast-forward it
  with `git push origin vX.Y.Z^{commit}:refs/heads/release`. The relay still follows `main`.
