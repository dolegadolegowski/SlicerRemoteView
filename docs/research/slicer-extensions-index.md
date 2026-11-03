# Submitting RemoteView to the Slicer Extensions Index: the index CI and the factory on a monorepo (SLC-72)

Research for SLC-72 (`docs/plan/slicer.md`), read on 2026-11-03; continues `slicer-packaging.md` §4. Sources:
`Slicer/ExtensionsIndex` `main` at `a29e47363096eafe4bd2c56d09ac581c9c381a39` and `5.12` at
`9647a9cf5b986d277abc2c3d3fbeed965c7da8e1`; `Slicer/Slicer` tag `v5.12.4` (`4e21c19d8360242d88d6ca2490bf52400441b8e1`);
`lassoan/Slicer` branch `python-ext-build` at `ca6a92aebf5beeb25a196be24dd79b452227404c`. Anything not read there or
run as described in §5 is marked `[TODO verify]`.

## 1. The index CI on a pull request

Four workflows run when a pull request adds `RemoteView.json`:

- **`lint.yml`** (`pull_request`, L1–23): `pre-commit` with the index's `.pre-commit-config.yaml` — no file over
  1 MB, LF line endings, no trailing whitespace or tabs, one final newline, `prettier` 3.5.3 on JSON (with
  `prettier-plugin-multiline-arrays`, threshold 0: a non-empty array one item per line, `.prettierrc.js`) and
  `check-jsonschema` against the index's own copy of schema v1.0.2. Our entry has the shape of the index's entries
  (183 of them hold `"build_dependencies": []`); `prettier` itself was not run here `[TODO verify]` on the pull
  request.
- **`extension-validation.yml`** (`pull_request`): `scripts/check_repository_structure.py` (the index's own layout:
  `*.json` and a few named files at its root, L19–46) and `scripts/check_description_files.py` on the changed files
  (L46–87). The job fails when either fails (L148–163). The report is a pull-request comment only when the branch
  lives in the index repository itself (L122–135); for a pull request from a fork it is in the run's summary
  (L89–108). `check_description_files.py` runs, per extension (L636–648): clone `scm_url` and check out
  `scm_revision` with plain `git` and no credentials (L347–374 — a private repository fails here first); the
  checkout, `.git` included, at most 100 MB (L471–491); the JSON against the `$schema` URL it names (L116–165) with
  LF line endings (L97–114); a name not starting with `slicer` unless grandfathered (L189–203, L743–800); the
  category among the accepted ones (L168–172, L810–872: `Remote` is one); a repository name starting with `Slicer`
  (L205–234); the GitHub topic `3d-slicer-extension`, read through the API (L236–280); an `https` or `git` URL
  (L175–187); the repository's top-level `CMakeLists.txt` (L377–468): the first match of
  `project\s*\(\s*([^\s\)\n\r]+)` anywhere in the file — comments included — must be the JSON's base name, and
  `set(EXTENSION_ICONURL "…")` and `set(EXTENSION_SCREENSHOTURLS "…")` (no space before the closing parenthesis)
  must be there with every URL served as an image (L282–313: `image/png|jpeg|gif`, or `application/octet-stream`
  for a URL ending in an image extension); a licence file at the root (L494–515: `LICENSE`, `LICENCE`,
  `License.txt`, `license.txt`, `LICENSE.txt`, `COPYING`, `COPYING.txt`); every `build_dependencies` entry in the
  index (L518–555).
- **`package-python-extension.yml`** (`pull_request`): for each changed JSON without `build_dependencies`, on
  Windows and Linux (macOS commented out, L68–75): `git clone` `scm_url` and `git checkout` `scm_revision` (default
  `main`, L48), skip if any `*.cxx` or `*.h` is in the checkout (L83–96; this repository has none), then
  `Utilities/Scripts/package_python_extension.py` of `lassoan/Slicer@python-ext-build` with `--ext-src` the checkout's
  root and `-DBUILD_TESTING=OFF` (L98–129). The script writes a stand-in Slicer build tree from those sources (its
  L155–326, L556–617; its `UseSlicer.cmake` takes `EXTENSION_NAME` from `PROJECT_NAME`, L346–350, and
  `EXTENSION_SOURCE_DIR` from `CMAKE_SOURCE_DIR`, L439–441), configures the root (L624–638), builds and runs `cpack`
  (L641–664); the package is a run artifact (L131–137).
- **`extension-ai-analysis.yml`** (`pull_request_target`): clones the repository and asks a language model twelve
  questions about its `*.py`, `*.md` and top-level `CMakeLists.txt` (`scripts/extension_ai_analysis.py` L34–47,
  L117–137) — e.g. whether it uploads data or downloads executable code, runs code at import, or pins packages that
  Slicer bundles. Every file of the clone counts: here 2.41 M characters of Markdown (172 files) and 1.93 M of
  Python (87 files), sent in batches of at most 400,000 characters (L31, L201–215) — about 77 model calls, at most
  10 a minute (L30, L139–150), within the job's 60 minutes (workflow L32); whether it finishes in time is
  `[TODO verify]`. The answers reach the run's summary only when the script ends (workflow L97–101); a failed clone
  makes it exit 1 (L290–294, L311–316), a red job.
- **Branch `5.12`** (at `9647a9c`) runs older copies: its topic check calls the API without a token and raises an
  uncaught `ValueError` on any answer but 200 (its `check_description_files.py` L259–265), so a rate-limited runner
  fails the validation (re-run it); its AI analysis asks eleven questions within 30 minutes.

## 2. The factory

`Extensions/CMake/SlicerBlockBuildPackageAndUploadExtensions.cmake` (v5.12.4) clones each entry's `scm_url` at its
`scm_revision` (`origin/main` when empty) into `<build>/<Name>` (L114–122, L140–148) and adds a build step per
extension (L232–250). `SlicerBlockBuildPackageAndUploadExtension.cmake` configures that clone's root with a cache
holding `<Name>_BUILD_SLICER_EXTENSION:BOOL=ON`, `Slicer_DIR` and the compilers (L127–142, L186–201), builds, builds
the `package` or `packageupload` target in `<Name>-build/<build_subdirectory>` (L214–259) and runs the tests, if any
(L262–280). A package is uploaded whatever the tests say; Stable packages are rebuilt during the day, Preview packages
every night, results on CDash (`Docs/developer_guide/extensions.md` L146–164, L601–612).

## 3. What the top level has to be

- `CMake/UseSlicer.cmake.in` L58–77: `EXTENSION_NAME` comes from `MODULE_NAME` if set, else `PROJECT_NAME`, so
  `project(<Name>)` precedes `include(${Slicer_USE_FILE})`; L377–396: `EXTENSION_LICENSE_FILE` and
  `EXTENSION_README_FILE` default to Slicer's own files, `EXTENSION_SOURCE_DIR` to `CMAKE_SOURCE_DIR`.
- `CMake/SlicerExtensionCPack.cmake` L44–47: packaging is skipped unless `EXTENSION_NAME` equals `PROJECT_NAME` where
  it is included. L59–60, L126–143: the package name `<Slicer_REVISION>-<os>-<arch>-<Name>-<type><revision>-<date>`
  and the generated description's `scm`/`scmrevision` come from `SlicerMacroExtractRepositoryInfo`, whose source
  directory defaults to `CMAKE_SOURCE_DIR` (`SlicerMacroExtractRepositoryInfo.cmake` L73–75) and which records a
  directory without `.git` as `local`, revision `NA` (L85–87).
- `CMake/SlicerMacroBuildScriptedModule.cmake` L64–84, L92–107: a module's files resolve against its own
  `CMAKE_CURRENT_SOURCE_DIR` and are copied to `${CMAKE_BINARY_DIR}/<qt-scripted-modules>` — the module's depth below
  the top level does not matter.
- The extension template, `Utilities/Templates/Extensions/Default/CMakeLists.txt` L1–25, has no `if()` around the
  module list; NVIDIA's `ai-assisted-annotation-client` adds its `slicer-plugin/` only under
  `<Name>_BUILD_SLICER_EXTENSION` (`slicer-packaging.md` §4), which the pull-request packaging test does not set.

## 4. Conventions in the index

- `scm_revision`: on branch `5.12`, 252 of 259 entries use `main` or `master` (268 of 277 on `main`); 254 of the 259
  have the same revision on both branches. A new Stable entry is its own pull request to `5.12` (e.g. `9647a9c` "Add
  AutomatedDentalToolsRemote extension (5.12)"). Each index branch serves the Slicer branch of the same name, and the
  entry must suit that Slicer version (`Docs/developer_guide/extensions.md` L376–380, L207–215).
- `EXTENSION_CONTRIBUTORS`: `Firstname1 Lastname1 ([SubOrg1, ]Org1), …` (same guide L331–332).
- The pull-request template (`.github/PULL_REQUEST_TEMPLATE.md` L13–38) lists the Tier 1 items; its homepage items
  (name, short description, an image, one sentence per module, publication, licence name) are read by the reviewers.

## 5. What was run here (2026-11-03) and what was not

- `tests/test_package.py` applies the regular expressions and licence names of §1 to the root `CMakeLists.txt`.
- `RemoteView.json` is valid against schema v1.0.2 (`jsonschema` 4.26.0; the schema on Slicer `main` is the
  `v5.12.4` blob `a62b14d5…`).
- A full clone (`git clone --no-local`): 18.7 MB with `.git` (limit 100 MB).
- `cmake` 4.3.3 configure, build and `cpack` of the repository root against a stub `SlicerConfig.cmake` written for
  this check (it imitates the rules of §3 in a few lines; it is not Slicer's code): `EXTENSION_NAME` `RemoteView`,
  `CMAKE_SOURCE_DIR` the repository root with its git revision and date in the package name, 31 scripts and
  35 resources found under `slicer-plugin/RemoteView`, a TGZ of the 66 module files under
  `lib/Slicer-5.12/qt-scripted-modules/`. On `main` before SLC-72 the root does not configure ("does not appear to
  contain CMakeLists.txt") and `slicer-plugin/` alone records "not a GIT checkout" (`localNA`).
- Not run: `package_python_extension.py`, `check_description_files.py` and `pre-commit` (downloaded code — this
  session's permission policy did not allow running it; the packaging command is in
  `docs/release/extensions-index.md`), Slicer's own CMake modules, the factory. `[TODO verify]` on the pull request
  (all four workflows) and on CDash after it.

## 6. Sources

- https://github.com/Slicer/ExtensionsIndex/blob/a29e47363096eafe4bd2c56d09ac581c9c381a39/scripts/check_description_files.py
- https://github.com/Slicer/ExtensionsIndex/tree/a29e47363096eafe4bd2c56d09ac581c9c381a39/.github/workflows
  (`extension-validation.yml`, `package-python-extension.yml`, `extension-ai-analysis.yml`), `scripts/` and
  `.github/PULL_REQUEST_TEMPLATE.md` at the same commit
- https://github.com/lassoan/Slicer/blob/ca6a92aebf5beeb25a196be24dd79b452227404c/Utilities/Scripts/package_python_extension.py
- https://github.com/Slicer/Slicer/tree/v5.12.4/Extensions/CMake (`SlicerBlockBuildPackageAndUploadExtensions.cmake`,
  `SlicerBlockBuildPackageAndUploadExtension.cmake`)
- https://github.com/Slicer/Slicer/tree/v5.12.4/CMake (`UseSlicer.cmake.in`, `SlicerExtensionCPack.cmake`,
  `SlicerMacroExtractRepositoryInfo.cmake`, `SlicerMacroBuildScriptedModule.cmake`)
- https://github.com/Slicer/Slicer/blob/v5.12.4/Utilities/Templates/Extensions/Default/CMakeLists.txt
- https://github.com/Slicer/Slicer/blob/v5.12.4/Docs/developer_guide/extensions.md
- https://raw.githubusercontent.com/Slicer/Slicer/main/Schemas/slicer-extension-catalog-entry-schema-v1.0.2.json
