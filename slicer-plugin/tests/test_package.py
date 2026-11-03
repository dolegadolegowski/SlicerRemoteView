"""SLC-20: the release zip of ``scripts/package.py`` and the single version."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

import remoteview_core

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PLUGIN_ROOT.parent
MODULE_DIR = PLUGIN_ROOT / "RemoteView"
SCRIPT = PLUGIN_ROOT / "scripts" / "package.py"

_SPEC = importlib.util.spec_from_file_location("package_script", SCRIPT)
assert _SPEC and _SPEC.loader
package = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(package)

VERSION = remoteview_core.__version__
ROOT = f"RemoteView-{VERSION}"


def _listed() -> set[str]:
    scripts, resources = package.cmake_listed_files((MODULE_DIR / "CMakeLists.txt").read_text())
    return scripts | resources


def _run(*args: str | Path, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    """The script as release.yml runs it: from the repository root, with the interpreter of the job."""
    clean = {k: v for k, v in os.environ.items() if not k.startswith(("GITHUB_", "SOURCE_DATE"))}
    return subprocess.run(
        [sys.executable, str(SCRIPT.relative_to(REPO_ROOT)), *map(str, args)],
        cwd=REPO_ROOT,
        env={**clean, **(env or {})},
        capture_output=True,
        text=True,
        check=False,
        timeout=120,
    )


@pytest.fixture(scope="module")
def built(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return package.build(tmp_path_factory.mktemp("dist"))


def test_package_zip_holds_exactly_the_cmake_listed_files_and_the_licence(built: Path):
    assert built.name == f"{ROOT}.zip"
    assert built.stat().st_mode & 0o777 == 0o644  # not mkstemp's private 0600
    with zipfile.ZipFile(built) as archive:
        names = archive.namelist()
        assert len(names) == len(set(names))
        assert set(names) == {f"{ROOT}/LICENSE.txt"} | {f"{ROOT}/RemoteView/{p}" for p in _listed()}
        # what the user adds to Additional module paths: RemoteView-<version>/RemoteView
        assert f"{ROOT}/RemoteView/RemoteView.py" in names
        assert f"{ROOT}/RemoteView/_vendor/remoteview_protocol/VENDORED.json" in names
        assert f"{ROOT}/RemoteView/Resources/Icons/RemoteView.png" in names
        for name in names:
            assert not re.search(
                r"(^|/)(tests?|__pycache__|\.[^/]*)(/|$)|\.py[co]$|CMakeLists\.txt$", name
            )
        # the bytes as committed (the vendored hashes, the icon), not re-encoded text
        for name in names:
            rel = name.removeprefix(f"{ROOT}/")
            source = REPO_ROOT / "LICENSE" if rel == "LICENSE.txt" else PLUGIN_ROOT / rel
            assert archive.read(name) == source.read_bytes(), name
        assert archive.testzip() is None


def test_package_vendored_files_match_their_manifest_inside_the_zip(built: Path):
    prefix = f"{ROOT}/RemoteView/_vendor/remoteview_protocol/"
    with zipfile.ZipFile(built) as archive:
        manifest = json.loads(archive.read(prefix + "VENDORED.json"))
        for rel, digest in manifest["files"].items():
            assert hashlib.sha256(archive.read(prefix + rel)).hexdigest() == digest, rel


def test_package_entries_are_plain_files_with_fixed_time_and_mode(built: Path):
    with zipfile.ZipFile(built) as archive:
        for info in archive.infolist():
            assert (
                not info.is_dir()
                and not info.filename.startswith("/")
                and ".." not in info.filename
            )
            assert info.date_time == (1980, 1, 1, 0, 0, 0)
            assert info.create_system == 3 and info.external_attr >> 16 == 0o100644
            assert info.compress_type == zipfile.ZIP_DEFLATED


def test_package_is_reproducible(tmp_path: Path, built: Path):
    again = package.build(tmp_path)
    assert again.read_bytes() == built.read_bytes()
    later = package.build(tmp_path / "later", timestamp=(2026, 11, 3, 12, 0, 0))
    with zipfile.ZipFile(later) as archive:
        assert {i.date_time for i in archive.infolist()} == {(2026, 11, 3, 12, 0, 0)}


def test_package_timestamp_follows_source_date_epoch():
    assert package.zip_timestamp({}) == (1980, 1, 1, 0, 0, 0)
    assert package.zip_timestamp({"SOURCE_DATE_EPOCH": "1762171200"}) == (2025, 11, 3, 12, 0, 0)
    # a zip entry cannot hold a time before 1980
    assert package.zip_timestamp({"SOURCE_DATE_EPOCH": "0"}) == (1980, 1, 1, 0, 0, 0)
    with pytest.raises(package.PackageError, match="SOURCE_DATE_EPOCH"):
        package.zip_timestamp({"SOURCE_DATE_EPOCH": "yesterday"})


# --------------------------------------------------------------------------- the module tree


@pytest.fixture
def module_copy(tmp_path: Path) -> Path:
    target = tmp_path / "src" / "RemoteView"
    shutil.copytree(MODULE_DIR, target, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".*"))
    return target


def test_package_leaves_out_caches_and_editor_files(tmp_path: Path, module_copy: Path):
    (module_copy / "remoteview_core" / "__pycache__").mkdir()
    (module_copy / "remoteview_core" / "__pycache__" / "panel.cpython-312.pyc").write_bytes(b"\0")
    (module_copy / "remoteview_core" / "stale.pyc").write_bytes(b"\0")
    (module_copy / ".pytest_cache").mkdir()
    (module_copy / ".pytest_cache" / "README.md").write_text("cache")
    (module_copy / ".DS_Store").write_bytes(b"\0")
    (module_copy / "remoteview_core" / ".panel.py.swp").write_bytes(b"\0")
    built = package.build(
        tmp_path / "out", module_dir=module_copy, license_file=REPO_ROOT / "LICENSE"
    )
    with zipfile.ZipFile(built) as archive:
        modules = {n.split("/RemoteView/", 1)[1] for n in archive.namelist() if "/RemoteView/" in n}
    assert modules == _listed()


@pytest.mark.parametrize(
    ("extra", "problem"),
    [
        ("remoteview_core/forgotten.py", "not in SCRIPTS: remoteview_core/forgotten.py"),
        ("tests/test_panel.py", "not in SCRIPTS: tests/test_panel.py"),
        ("Resources/UI/Extra.ui", "not in RESOURCES: Resources/UI/Extra.ui"),
    ],
)
def test_package_refuses_a_file_the_cmake_lists_miss(
    tmp_path: Path, module_copy: Path, extra: str, problem: str
):
    """A file Slicer would not install (or a test left in the module) stops the build: the zip is never short."""
    (module_copy / extra).parent.mkdir(parents=True, exist_ok=True)
    (module_copy / extra).write_text("")
    with pytest.raises(package.PackageError, match=re.escape(problem)):
        package.build(tmp_path / "out", module_dir=module_copy, license_file=REPO_ROOT / "LICENSE")
    assert not (tmp_path / "out").exists() or list((tmp_path / "out").iterdir()) == []


def test_package_refuses_a_listed_file_that_is_missing(tmp_path: Path, module_copy: Path):
    (module_copy / "remoteview_core" / "ids.py").unlink()
    with pytest.raises(
        package.PackageError, match=re.escape("listed but missing: remoteview_core/ids.py")
    ):
        package.build(tmp_path / "out", module_dir=module_copy, license_file=REPO_ROOT / "LICENSE")


def test_package_refuses_symlinks(tmp_path: Path, module_copy: Path):
    secret = tmp_path / "secret.txt"
    secret.write_text("not for the zip")
    icon = module_copy / "Resources" / "Icons" / "RemoteView.png"
    icon.unlink()
    icon.symlink_to(secret)
    with pytest.raises(
        package.PackageError, match=re.escape("symlink: Resources/Icons/RemoteView.png")
    ):
        package.build(tmp_path / "out", module_dir=module_copy, license_file=REPO_ROOT / "LICENSE")


def test_package_refuses_a_missing_licence(tmp_path: Path, module_copy: Path):
    with pytest.raises(package.PackageError, match="missing"):
        package.build(
            tmp_path / "out", module_dir=module_copy, license_file=tmp_path / "LICENSE.txt"
        )


# --------------------------------------------------------------------------- the version


def test_package_version_is_written_once():
    assert package.read_version() == VERSION
    pattern = re.compile(rf"(?<![0-9.]){re.escape(VERSION)}(?![0-9])")
    hits = [
        p.relative_to(REPO_ROOT).as_posix()
        for p in [
            *MODULE_DIR.rglob("*.py"),
            PLUGIN_ROOT / "pyproject.toml",
            PLUGIN_ROOT / "CMakeLists.txt",
            REPO_ROOT / "CMakeLists.txt",
            PLUGIN_ROOT / "RemoteView.json",
        ]
        if "_vendor" not in p.parts and pattern.search(p.read_text(encoding="utf-8"))
    ]
    assert hits == ["slicer-plugin/RemoteView/remoteview_core/__init__.py"]


@pytest.mark.parametrize(
    ("source", "message"),
    [
        ("", "no __version__"),
        ("__version__ = 1\n", "no __version__"),
        ("def f():\n    __version__ = '1.0.0'\n", "no __version__"),
        ("__version__ = '0.1'\n", "is not X.Y.Z"),
        ("__version__ = '0.1.0/../x'\n", "is not X.Y.Z"),
    ],
)
def test_package_read_version_rejects(tmp_path: Path, source: str, message: str):
    path = tmp_path / "__init__.py"
    path.write_text(source)
    with pytest.raises(package.PackageError, match=message):
        package.read_version(path)


@pytest.mark.parametrize("version", ["0.1.0", "10.20.30", "0.0.1-rc.1"])
def test_package_read_version_accepts(tmp_path: Path, version: str):
    path = tmp_path / "__init__.py"
    path.write_text(f'"""Doc."""\n\n__version__ = "{version}"\n')
    assert package.read_version(path) == version


def test_package_tag_version_only_on_a_tag_run():
    assert package.tag_version({"GITHUB_REF_TYPE": "tag", "GITHUB_REF_NAME": "v0.1.0"}) == "0.1.0"
    assert package.tag_version({"GITHUB_REF_TYPE": "branch", "GITHUB_REF_NAME": "v0.1.0"}) is None
    assert package.tag_version({"GITHUB_REF_TYPE": "tag", "GITHUB_REF_NAME": "release-1"}) is None
    assert package.tag_version({}) is None


# --------------------------------------------------------------------------- the command line and release.yml


def test_package_cli_on_the_matching_tag(tmp_path: Path):
    result = _run(
        "--output-dir", tmp_path, env={"GITHUB_REF_TYPE": "tag", "GITHUB_REF_NAME": f"v{VERSION}"}
    )
    assert result.returncode == 0, result.stderr
    assert [p.name for p in tmp_path.iterdir()] == [f"{ROOT}.zip"]
    assert f"version {VERSION}" in result.stdout


@pytest.mark.parametrize(
    ("args", "env"),
    [
        ((), {"GITHUB_REF_TYPE": "tag", "GITHUB_REF_NAME": "v9.9.9"}),
        (("--expect-version", "0.1.0-rc.1"), {}),
    ],
    ids=["tag", "flag"],
)
def test_package_cli_refuses_another_version(
    tmp_path: Path, args: tuple[str, ...], env: dict[str, str]
):
    result = _run("--output-dir", tmp_path, *args, env=env)
    assert result.returncode == 1
    assert "remoteview_core/__init__.py says __version__" in result.stderr
    assert list(tmp_path.iterdir()) == []


def test_package_default_output_is_where_release_yml_finds_it():
    """release.yml runs ``python slicer-plugin/scripts/package.py`` with no arguments from the repository root and
    takes the first ``RemoteView-*.zip`` that ``find .`` (``./node_modules`` pruned) lists as newer than
    CHANGELOG.md."""
    workflow = (REPO_ROOT / ".github" / "workflows" / "release.yml").read_text()
    assert re.search(r"^\s*python slicer-plugin/scripts/package\.py\s*$", workflow, re.MULTILINE)
    assert '-name "RemoteView-*.zip" -newer CHANGELOG.md' in workflow
    out = package.DEFAULT_OUTPUT_DIR.relative_to(REPO_ROOT)
    assert out.parts[0] != "node_modules"
    assert re.fullmatch(r"RemoteView-.*\.zip", f"{ROOT}.zip")
    # git-ignored, so a local build never shows up as a change
    ignored = subprocess.run(
        ["git", "check-ignore", "-q", str(out / f"{ROOT}.zip")], cwd=REPO_ROOT, check=False
    )
    assert ignored.returncode == 0


def test_package_licence_is_the_repository_licence(built: Path):
    assert package.LICENSE_FILE == REPO_ROOT / "LICENSE"
    assert (REPO_ROOT / "LICENSE").read_text().startswith("MIT License\n")
    with zipfile.ZipFile(built) as archive:
        assert archive.read(f"{ROOT}/LICENSE.txt") == (REPO_ROOT / "LICENSE").read_bytes()


# --------------------------------------------------------------------------- the Extensions Index entry

#: Catalog entry schema v1.0.2 (Slicer v5.12.4 ``Schemas/slicer-extension-catalog-entry-schema-v1.0.2.json``, the one
#: ExtensionsIndex's pre-commit validates against): the required keys and every allowed one (``additionalProperties``
#: false). Sources: ``docs/research/slicer-packaging.md``.
CATALOG_REQUIRED = {"$schema", "category", "scm_url"}
CATALOG_KEYS = CATALOG_REQUIRED | {
    "build_dependencies",
    "build_subdirectory",
    "dicom_support_rule",
    "enabled",
    "scm_revision",
    "scm_type",
    "tier",
}
REPOSITORY = "https://github.com/dolegadolegowski/SlicerRemoteView"
RAW_MAIN = "https://raw.githubusercontent.com/dolegadolegowski/SlicerRemoteView/main/"
#: The extension's top level, the only copy of its metadata: the index CI and the factory configure the root of the
#: clone (SLC-72, ADR 0010).
EXTENSION_CMAKE = REPO_ROOT / "CMakeLists.txt"
#: How the index CI reads the top-level CMakeLists.txt — the patterns and flags of ExtensionsIndex
#: ``scripts/check_description_files.py`` L410, L432, L448 and its licence names L497 (``main`` at ``a29e473``,
#: 2026-11-03): the first ``project(`` anywhere in the file, comments included, names the extension.
INDEX_PROJECT_RE = re.compile(r"project\s*\(\s*([^\s\)\n\r]+)", re.IGNORECASE | re.MULTILINE)
INDEX_ICONURL_RE = re.compile(
    r'set\s*\(EXTENSION_ICONURL\s*"([^"]+)"[ ]*\)', re.IGNORECASE | re.MULTILINE
)
INDEX_SCREENSHOTURLS_RE = re.compile(
    r'set\s*\(EXTENSION_SCREENSHOTURLS\s*"([^"]+)"\)', re.IGNORECASE | re.MULTILINE
)
INDEX_LICENSE_NAMES = (
    "LICENSE",
    "LICENCE",
    "License.txt",
    "license.txt",
    "LICENSE.txt",
    "COPYING",
    "COPYING.txt",
)


def _cmake_set(name: str) -> str:
    """The quoted value of ``set(<name> "...")`` in the extension's top-level CMakeLists.txt, which sets it once —
    comments included, so a commented-out older line cannot be the one a reader finds first."""
    text = EXTENSION_CMAKE.read_text(encoding="utf-8")
    values = re.findall(rf'set\s*\({name}\s*"([^"]*)"\)', text)
    assert len(values) == 1, f"{name}: {len(values)} quoted set() lines"
    return values[0]


def _tracked(rel: str) -> bool:
    """Whether git tracks ``rel`` (a raw URL serves only committed files)."""
    result = subprocess.run(
        ["git", "ls-files", "--error-unmatch", rel], cwd=REPO_ROOT, capture_output=True, check=False
    )
    return result.returncode == 0


def test_package_catalog_entry_matches_the_schema_and_the_cmake_metadata():
    path = PLUGIN_ROOT / "RemoteView.json"
    raw = path.read_bytes()
    assert b"\r" not in raw and raw.endswith(b"}\n")  # the index CI wants LF line endings
    entry = json.loads(raw)
    assert CATALOG_REQUIRED <= entry.keys() <= CATALOG_KEYS
    assert list(entry) == sorted(entry)  # the key order of the index's entries
    assert entry["$schema"] == (
        "https://raw.githubusercontent.com/Slicer/Slicer/main/Schemas/"
        "slicer-extension-catalog-entry-schema-v1.0.2.json#"
    )
    # the file is named after the extension: the project() of the repository's top-level CMakeLists.txt
    project = re.search(r"^project\((\w+)\)", EXTENSION_CMAKE.read_text(encoding="utf-8"), re.M)
    assert project and path.stem == project.group(1) == package.ARCHIVE_PREFIX
    assert entry["category"] == _cmake_set("EXTENSION_CATEGORY") == "Remote"
    assert entry["scm_url"] == f"{REPOSITORY}.git"
    # the homepage is the extension's README as GitHub shows it
    assert _cmake_set("EXTENSION_HOMEPAGE") == f"{REPOSITORY}/tree/main/slicer-plugin"
    # Slicer's CMake reader requires scm_revision, although the schema does not
    assert entry["scm_revision"] == "main"
    assert entry["build_dependencies"] == [] and _cmake_set("EXTENSION_DEPENDS") == "NA"
    assert entry["build_subdirectory"] == "." and entry["tier"] == 1


def test_package_cmake_image_urls_point_at_committed_pngs():
    icon = _cmake_set("EXTENSION_ICONURL").split()
    screenshots = _cmake_set("EXTENSION_SCREENSHOTURLS").split()  # space-separated
    assert len(icon) == 1 and screenshots
    for url in icon + screenshots:
        assert url.startswith(RAW_MAIN), url  # the raw file, not the GitHub page
        rel = url.removeprefix(RAW_MAIN)
        assert _tracked(rel), f"{rel} is not committed"
        data = (REPO_ROOT / rel).read_bytes()
        assert data[:8] == b"\x89PNG\r\n\x1a\n", url
    data = (REPO_ROOT / icon[0].removeprefix(RAW_MAIN)).read_bytes()
    width, height = int.from_bytes(data[16:20]), int.from_bytes(data[20:24])  # the IHDR chunk
    assert (width, height) == (128, 128)


def test_package_top_level_cmake_reads_as_the_index_ci_reads_it():
    """The index CI's checks of the repository (``check_description_files.py``) on our files."""
    text = EXTENSION_CMAKE.read_text(encoding="utf-8")
    name = PLUGIN_ROOT.joinpath("RemoteView.json").stem
    # one match each: the index CI takes the first, CMake the last one it runs, so a second (a comment naming
    # another project, a commented-out older URL) could make them disagree
    projects = INDEX_PROJECT_RE.findall(text)
    assert len(projects) == 1 and projects[0].strip("\"'") == name
    icons = INDEX_ICONURL_RE.findall(text)
    screenshots = INDEX_SCREENSHOTURLS_RE.findall(text)
    assert len(icons) == 1 and icons[0].strip() == _cmake_set("EXTENSION_ICONURL")
    assert len(screenshots) == 1
    assert screenshots[0].split() == _cmake_set("EXTENSION_SCREENSHOTURLS").split()
    # check_extension_name and check_git_repository_name (L189–234)
    assert not name.lower().startswith("slicer")
    assert REPOSITORY.rsplit("/", 1)[1].startswith("Slicer")
    # check_license_file (L494–515): the first of its names found at the root, the repository's MIT licence
    licences = [n for n in INDEX_LICENSE_NAMES if (REPO_ROOT / n).is_file()]
    assert licences[:1] == ["LICENSE"] and _tracked("LICENSE")
    assert (REPO_ROOT / "LICENSE").read_text().startswith("MIT License\n")


def test_package_contributors_name_a_person_and_an_organization():
    """``Firstname Lastname (Organization)``, comma-separated for several (Slicer 5.12.4
    ``Docs/developer_guide/extensions.md``, *Supported metadata fields*)."""
    contributors = _cmake_set("EXTENSION_CONTRIBUTORS")
    person = r"[^\s,()]+(?: [^\s,()]+)+ \([^()]+\)"
    assert re.fullmatch(rf"{person}(?:, {person})*", contributors), contributors
    assert contributors == "Damian Dołęga-Dołęgowski (SlicerRemoteView)"
