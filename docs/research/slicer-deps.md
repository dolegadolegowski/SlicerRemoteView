# Research — installing `websockets` and `segno` on first use (SLC-10)

Facts below were read in the sources of Slicer **v5.12.4** (`Base/Python/slicer/packaging.py`, `util.py`; fetched
2026-10-21; `pip_ensure` has the same signature in v5.12.0 and v5.12.2, and no `v5.11.0` tag exists) and checked against
the sandbox where possible. Nothing here ran inside Slicer (CLAUDE.md rule 10); the
manual steps are `docs/testing/slicer.md` §3.

Sources: [packaging.py @ v5.12.4](https://github.com/Slicer/Slicer/blob/v5.12.4/Base/Python/slicer/packaging.py),
[util.py @ v5.12.4](https://github.com/Slicer/Slicer/blob/v5.12.4/Base/Python/slicer/util.py),
`docs/research/slicer.md` §6 (FAQ rules, `slicer.packaging` absent in 5.10.0).

## What Slicer gives us

| Fact | Where |
|---|---|
| `slicer.packaging.pip_ensure(requirements, constraints=None, skip_packages=None, prompt_install=True, prompt_restart=True, requester=None, skip_in_testing=True, show_progress=True)` checks each requirement with `pip_check` (installed version inside the specifier — `==17.2` is exact), installs only the missing ones with `pip_install(..., blocking=True)`, and returns `None` unless `skip_packages` is given | `packaging.py` `pip_ensure` |
| With `prompt_install=True` it shows a generic dialog ("N Python packages need to be installed … This will modify Slicer's Python environment. Continue?") and raises `RuntimeError("User declined package installation")` on Cancel. SLC-10 shows its own dialog (what, why, from where, which installed version is replaced) and passes `prompt_install=False` | `pip_ensure` |
| `skip_in_testing=True`: when `slicer.app.testingEnabled()`, nothing is installed and `pip_ensure` returns `None` — the sequence therefore checks again after the installer returns and reports "still missing" | `pip_ensure` |
| `prompt_restart=True` (the default): after an install it compares the versions before and after and, if an *already imported* package was updated, asks "Restart Slicer now?" and calls `slicer.util.restart()`. SLC-10 passes `prompt_restart=False`: `deps.stale_modules` finds that case itself and the panel says "Restart Slicer", so there is one message, not two | `pip_ensure` |
| `pip_install` with a progress dialog (`show_progress=True`, blocking) runs pip in the background but loops on `slicer.app.processEvents()` until it ends, so the GUI stays responsive and a second click on *Start session* can arrive during the install (the controller refuses it) | `_pip_install_with_dialog` |
| On a failed install Slicer shows its own error dialog with pip's log and raises `subprocess.CalledProcessError(returncode, "pip install")`. Every pip line is also `print`ed (`onLog`), i.e. it reaches Slicer's Python console and application log; RemoteView's own text and log line hold no pip text | `_pip_install_with_dialog` |
| A string `requirements` is split with `shlex.split` (POSIX mode: backslashes are escapes, spaces separate), a list is passed as is — the README's offline command uses the list form so that `C:\Users\me\wheels` and paths with spaces survive | `_build_pip_args` |
| `slicer.util.confirmOkCancelDisplay(text, windowTitle=None, parent=None, **kwargs)` returns `True` for OK; extra keyword arguments (`detailedText`) reach the message box; in testing mode it returns `True` without showing anything | `util.py` |
| `slicer.packaging` does not exist in Slicer 5.10.0. The module targets Slicer 5.12.x (NFR-24) and has no fallback for older builds: `from slicer import packaging` fails there and the sequence ends with the fixed "could not be installed" text | `docs/research/slicer.md` §6 |

## Decisions

1. **Exact pins** (T12, ADR 0009 item 7): `websockets==17.2`, `segno==1.6.6`. `segno` 1.6.6 is the newest release on PyPI
   today (`pip index versions segno`); SLC-11 tests against it. `websockets` 17.3 exists but is untested.
2. **Another installed release counts as missing**, older or newer (`17.2.0` is the release `17.2`, as for pip's `==`).
   The dialog names it and says it is replaced — or downgraded, for a higher version such as `websockets` 17.3 (on PyPI
   today) — and that other extensions using the package get the tested one. Accepting a range instead would run code
   nobody here tested; the user decides in the dialog, and *Cancel* changes nothing ("Nothing was installed or changed").
   If the package is already imported in another release the installation changes the files on disk only, so the
   sequence ends in "Restart Slicer" (`Outcome.RESTART`).
3. **Hashes**: `--require-hashes` is not used. `pip_ensure` takes requirement specifiers only (no `--hash`); FR-16 names
   `pip_ensure`, which also gives the progress window, the error dialog and the check for packages that were loaded
   before. `pip_install` does take pip arguments, so `--require-hashes -r hashed-requirements.txt` (with
   `--only-binary :all:`, because a source distribution runs a build script) would be possible there; the price is a
   second code path and a hash file to refresh on every pin change. Not done now: the residual risk — a compromised PyPI
   release of the *exact* pinned version, or a swapped wheel — is T12's "zero-days; review of upgrades is manual".
   `release` may ask for hashes; the package list is one tuple (`deps.PACKAGES`). The dev environment installs wheels only
   (`--only-binary :all:`, SLC-02); the runtime install through `pip_ensure` cannot pass that flag, so pip could take a
   source distribution and run its build backend if a mirror offered no wheel (both pins publish `py3-none-any`
   wheels on PyPI today). The `pip_install` path above should add `--only-binary :all:`.
4. **`RelayTransport.start()` keeps its floor** (`websockets` ≥ 15 with `process_redirect`): the exact pin is enforced where
   packages are installed (`deps.py`), not by a second check at connect time. The two rules differ on purpose — the
   floor is what the code needs to run, the pin is what was tested — and a user who cancels the replacement of a working
   `websockets` 16.x cannot start a session from this panel until they accept it; the only other way out is for
   `release` to relax the pin to a range (`deps.PACKAGES`), should that prove too strict.
5. **Failure texts are fixed.** pip's messages can carry proxy URLs with credentials; RemoteView's log line holds the
   exception type only and the panel a fixed guidance text. Slicer prints pip's own output to its console and log; that
   is outside this module.
6. **Order**: the relay address and CA file are validated first (no prompt for an address that will be refused), then the
   packages, then the transport thread starts. Opening the panel, constructing the widget and loading the module run no
   pip, no subprocess and no network access (tests: `tests/test_deps.py`).

## Not verified

- The whole flow inside Slicer 5.12.4 on Windows and macOS (dialogs, progress window, restart prompt) — manual §3.
- That a loaded extension module (`websockets`' speedups) can be replaced on Windows while Slicer runs — manual §3 step 6
  says what to note (the restart text, or the fixed failure text with the package unchanged).
- That a package installed during the session is importable without a restart: `importlib.invalidate_caches()` runs after
  the install, and `websockets`/`segno` are pure imports with no extension-loading state; to be confirmed in manual §3.
