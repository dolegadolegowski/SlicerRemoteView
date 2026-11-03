# Packaging the Slicer extension: release zip and Extensions Index (SLC-20)

Research for SLC-20 (`docs/plan/slicer.md`), read on 2026-11-03 against Slicer **v5.12.4** (the installed
`/Applications/Slicer.app`, macOS Intel build, and the tag's sources) and `Slicer/ExtensionsIndex` at `main`
`29296c88c3ddb3572c13af36e45734c3d5bc7fc2` (branch `5.12` at `9647a9cf5b986d277abc2c3d3fbeed965c7da8e1`).
Everything below was read in the cited source unless it is marked `[TODO verify]`.

## 1. How Slicer loads a module from *Additional module paths*

- The setting `Modules/AdditionalPaths` is added verbatim to the module factory's search paths
  (`Base/QTApp/qSlicerApplicationHelper.cxx` L209 at v5.12.4); the scripted-module factory searches those paths first,
  then `<slicerHome>/<Slicer_QTSCRIPTEDMODULES_LIB_DIR>` (`Base/QTGUI/qSlicerScriptedLoadableModuleFactory.cxx`
  L126–167).
- Discovery is **not recursive**: `registerModules(path)` iterates `QDir(path).entryInfoList(QDir::Files)` (top-level
  files only, with a `\tbd recursive search ?` comment — `Base/QTCore/qSlicerAbstractModuleFactoryManager.cxx`
  L263–283). Every top-level `*.py` is a module candidate (a `#!` first line marks a CLI script instead; the class must
  be named after the file — `qSlicerScriptedLoadableModuleFactory.cxx` L102–106, L182–211). So the folder to add is
  the one that holds `RemoteView.py`, and no other `.py` may sit next to it; `remoteview_core/`, `_vendor/` and
  `Resources/` are not scanned.
- A non-embedded scripted module's directory is appended to `PYTHONPATH` (`qSlicerScriptedLoadableModuleFactory.cxx`
  L44–65), which is why `import remoteview_core` works from the unzipped folder.
- Checked natively (2026-11-03, Slicer 5.12.4): with `--disable-settings --additional-module-paths
  <unzipped>/SlicerRemoteView-0.1.0/RemoteView`, `slicer.modules.remoteview` exists, its `path` and
  `remoteview_core.__file__` are inside the unzipped folder, `remoteview_core.__version__` is `0.1.0` and the panel
  opens (`docs/testing/slicer.md` §10 steps 1–3).

## 2. The release zip (`slicer-plugin/scripts/package.py`)

- Layout: `SlicerRemoteView-<version>/LICENSE.txt` and `SlicerRemoteView-<version>/RemoteView/**`. macOS Archive
  Utility (double-click) gives `SlicerRemoteView-0.1.0/RemoteView/RemoteView.py` (checked 2026-11-03). Windows
  *Extract All* proposes a folder named after the zip, so the path gets one more `SlicerRemoteView-0.1.0` level
  `[TODO verify]` on Windows — the user guide's rule "add the folder that contains `RemoteView.py`" covers both.
- Contents: exactly the files `RemoteView/CMakeLists.txt` lists in `MODULE_PYTHON_SCRIPTS` and
  `MODULE_PYTHON_RESOURCES` — the files `slicerMacroBuildScriptedModule` installs for an Extensions Manager build
  (the scripted-module template lists every file, nothing is globbed:
  `share/Slicer-5.12/Wizard/Templates/Modules/Scripted/CMakeLists.txt` L1–32 in the app bundle). The packager refuses
  to build when the tree and the lists differ (the check `tests/test_skeleton.py` runs, same code), so the zip never
  misses a module file and never carries tests, caches, `.pyc` or hidden files. Symlinks are refused.
- `release.yml` (DEP-11) runs `python slicer-plugin/scripts/package.py` from the repository root with no arguments and
  takes the first `SlicerRemoteView-*.zip` that `find .` (`./node_modules` pruned) finds newer than `CHANGELOG.md`.
  The default output `slicer-plugin/dist/` (git-ignored by the root `.gitignore`'s `dist/`) satisfies that: the step
  was re-run locally, verbatim, with Python 3.12.15 in a copy of the tree (zip found, copied, the secret-file listing
  check passed). On a tag run the packager compares `GITHUB_REF_NAME` (`v0.1.0` → `0.1.0`, only when
  `GITHUB_REF_TYPE` is `tag`; both are default GitHub Actions variables) with `__version__` and fails on a mismatch,
  because the workflow would otherwise rename a zip of another version to the tag's name.
- Reproducible bytes: sorted entries, mode 0644, one timestamp (`SOURCE_DATE_EPOCH` or 1980-01-01), deflate level 9.

## 3. The version in one place

`__version__` in `RemoteView/remoteview_core/__init__.py` is the only place. `pyproject.toml` declares
`dynamic = ["version"]` with `[tool.setuptools.dynamic] version = { attr = "remoteview_core.__version__" }` and
`package-dir = { "" = "RemoteView" }`:

- setuptools 80.9.0's `read_configuration(..., expand=True)` returns `0.1.0` for it (checked 2026-11-03 with
  `uv run --with setuptools==80.9.0`);
- `uv pip compile` (uv 0.12.23, the command in `requirements-dev.txt`'s header) still reads the `dev` extra
  statically — its debug log says `Found static requires-dist` — and builds nothing, so the "no build-time code"
  stance of that file holds.

The Slicer extension metadata has **no version field**: `Extensions/CMake/SlicerExtensionDescriptionSpec.cmake` at
v5.12.4 defines 17 fields (L61–145), none a version; `slicerFunctionGenerateExtensionDescription` takes no
`EXTENSION_VERSION`; the catalog entry schema has none either. The module's `parent` metadata shows none.

## 4. The Extensions Index entry (`slicer-plugin/SlicerRemoteView.json`)

- Format: JSON catalog entry, schema **v1.0.2**
  (`https://raw.githubusercontent.com/Slicer/Slicer/main/Schemas/slicer-extension-catalog-entry-schema-v1.0.2.json#`,
  the schema's `$id`; ExtensionsIndex's pre-commit validates every entry against its copy, same blob
  `a62b14d5…`). Draft-07, `additionalProperties: false`; required `$schema`, `category`, `scm_url`; optional
  `scm_revision`, `scm_type` (`git`|`local`), `build_dependencies` (array of extension names), `dicom_support_rule`,
  `build_subdirectory` (default `.`), `enabled`, `tier` (1–5). v1.0.2 differs from v1.0.1 only by
  `dicom_support_rule`.
- `scm_revision` is required in practice: Slicer's CMake reader lists `SCM_URL`, `SCM_REVISION`, `CATEGORY` as required
  (`Extensions/CMake/SlicerFunctionExtractExtensionDescription.cmake` L146–150). The PR template recommends a branch
  name (`main` for Preview; `(major).(minor)` for Stable — ExtensionsIndex `.github/PULL_REQUEST_TEMPLATE.md` L4).
- `build_subdirectory` is the inner **build** directory of a superbuild extension, not a source subdirectory
  (`SlicerExtensionDescriptionSpec.cmake` L87–90); `.` for us.
- Category `Remote` is in the index CI's accepted list (`scripts/check_description_files.py` L810–846; `XNATSlicer`
  uses it). Tier 1 = experimental, 3 = community-supported, 5 = core (`README.md` L18–26).
- Branches: ExtensionsIndex `main` serves the Preview release, `5.12` the 5.12 Stable release
  (`Docs/developer_guide/extensions.md` L207–215 at v5.12.4); usually both.
- Our entry is internally consistent (the file name is the `project()` name, category, `scm_url` = homepage + `.git`,
  `build_dependencies` `[]` = `EXTENSION_DEPENDS "NA"`; `tests/test_package.py` checks it) but **cannot be submitted
  as the repository stands** — blockers, all decisions outside SLC-20:
  1. **Name.** The index CI fails an extension name (the JSON base name, which must equal the top-level `project()`)
     that starts with `Slicer` unless it is grandfathered (`check_description_files.py` L189–235; PR template L13–17:
     only for a bridge to a third-party tool). `SlicerRemoteView` would need renaming, e.g. to `RemoteView`
     (`project(RemoteView)`, `RemoteView.json`); the *repository* name `SlicerRemoteView` is what the CI wants.
  2. **Extension root at the repository root.** The factory clones `scm_url` and configures the clone's root
     (`SlicerBlockBuildPackageAndUploadExtensions.cmake` L115–122, L186, L236); the index CI wants `CMakeLists.txt`
     (with `EXTENSION_ICONURL` and `EXTENSION_SCREENSHOTURLS`) and the licence file in the repository root
     (`check_description_files.py` L377–468, L494–515). Our extension root is `slicer-plugin/`. Options: a root
     `CMakeLists.txt` that adds `slicer-plugin`, or a separate extension repository. The one precedent, NVIDIA
     `ai-assisted-annotation-client` (root `CMakeLists.txt` L34–49), adds its `slicer-plugin/` only when
     `<Name>_BUILD_SLICER_EXTENSION` is set — the factory sets it (`SlicerBlockBuildPackageAndUploadExtension.cmake`
     L97), but the index's pull-request packaging test (`.github/workflows/package-python-extension.yml`, running
     `package_python_extension.py` from `lassoan/Slicer` branch `python-ext-build`, L624–638) does not, and that root
     file lacks the `EXTENSION_ICONURL`/`EXTENSION_SCREENSHOTURLS` today's CI requires. A wrapper would have to add the
     extension unconditionally and carry the `EXTENSION_*` lines itself; whether such a wrapper packages correctly
     with the extension's `project()`/`Slicer_EXTENSION_CPACK` one level down is `[TODO verify]`.
  3. **Public repository** with the GitHub topic `3d-slicer-extension` (developer guide L201; PR template L18–19; CI
     clones without credentials and reads the topic through the API). The icon and screenshot raw URLs in
     `slicer-plugin/CMakeLists.txt` also only resolve once the repository is public and the files are on `main`.
  4. **Licence file name.** CI accepts the root `LICENSE` (`LICENSE`, `LICENCE`, `LICENSE.txt`, … at L494–515); the PR
     template's wording says `LICENSE.txt`.
  5. `EXTENSION_CONTRIBUTORS` should read `Firstname Lastname (Organization)` (developer guide L331–332); ours is
     `SlicerRemoteView contributors`.
- Tier-1 checklist items that the module already meets: no data sent without explicit opt-in (*Start session*;
  `tests/test_skeleton.py`), pip packages installed only after asking (allowed: `Docs/developer_guide/python_faq.md`
  L355–385 at v5.12.4 — note it also advises `>=` pins rather than exact ones, while we pin exactly for T12), MIT
  licence, 128×128 PNG icon, a screenshot (`slicer-plugin/Screenshots/RemoteView-panel.png`, a generated sphere,
  no patient data), README with description, image and data-flow statement (`slicer-plugin/README.md`).
