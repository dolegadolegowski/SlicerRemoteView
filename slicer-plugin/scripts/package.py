#!/usr/bin/env python3
"""Build the release zip of the RemoteView extension of SlicerRemoteView (SLC-20, DEP-11).

    python slicer-plugin/scripts/package.py                      # -> slicer-plugin/dist/RemoteView-<version>.zip
    python slicer-plugin/scripts/package.py --output-dir DIR     # somewhere else
    python slicer-plugin/scripts/package.py --expect-version X   # fail unless the module's version is X

The archive holds one folder ``RemoteView-<version>/`` with ``LICENSE.txt`` (the repository's ``LICENSE``) and
the module folder
``RemoteView/`` — exactly the files that ``RemoteView/CMakeLists.txt`` lists (the files an Extensions Manager build
installs), so tests, caches, ``.pyc`` files and editor files never get in. The user adds
``RemoteView-<version>/RemoteView`` (the folder with ``RemoteView.py``) to *Additional module paths*.

The version is ``__version__`` of ``RemoteView/remoteview_core/__init__.py``, the only place it is written (read
here without importing the package). Run by ``.github/workflows/release.yml`` on a ``v*`` tag: there the tag
(``GITHUB_REF_NAME`` when ``GITHUB_REF_TYPE`` is ``tag``) must name the same version, or nothing is built.

The zip is reproducible: sorted entries, fixed permissions and one timestamp (``SOURCE_DATE_EPOCH`` when set,
otherwise 1980-01-01), file bytes as checked out. Standard library only (Python 3.12); never imported by the module.
"""

from __future__ import annotations

import argparse
import ast
import os
import re
import sys
import tempfile
import time
import zipfile
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
MODULE_DIR = PLUGIN_ROOT / "RemoteView"
VERSION_FILE = MODULE_DIR / "remoteview_core" / "__init__.py"
#: The repository's licence (MIT), shipped as ``LICENSE.txt``; the Extensions Index looks for it at the repository root.
LICENSE_FILE = PLUGIN_ROOT.parent / "LICENSE"
DEFAULT_OUTPUT_DIR = PLUGIN_ROOT / "dist"
#: The extension's name: ``project()`` of the repository's top-level ``CMakeLists.txt`` (``tests/test_package.py``).
ARCHIVE_PREFIX = "RemoteView"
#: ``X.Y.Z`` or ``X.Y.Z-<pre-release>`` (a tag ``vX.Y.Z-rc.1`` makes a pre-release, docs/deploy.md §8); safe in a
#: file name.
VERSION_RE = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z][0-9A-Za-z.]*)?")
#: The earliest time a zip entry can hold (DOS date), used when ``SOURCE_DATE_EPOCH`` is not set.
DEFAULT_TIMESTAMP = (1980, 1, 1, 0, 0, 0)

_SET_RE = re.compile(
    r"set\(\s*(MODULE_PYTHON_SCRIPTS|MODULE_PYTHON_RESOURCES)\s+(.*?)\)", re.DOTALL
)
_TREE_EXCLUDED_DIRS = {"__pycache__", ".pytest_cache", ".ruff_cache"}


class PackageError(Exception):
    """The archive cannot be built as asked; the message says why."""


def read_version(path: Path = VERSION_FILE) -> str:
    """The string assigned to ``__version__`` at the top level of ``path`` (parsed, not imported)."""
    for node in ast.parse(path.read_text(encoding="utf-8")).body:
        if (
            isinstance(node, ast.Assign)
            and [getattr(t, "id", None) for t in node.targets] == ["__version__"]
            and isinstance(node.value, ast.Constant)
            and isinstance(node.value.value, str)
        ):
            version = node.value.value
            if not VERSION_RE.fullmatch(version):
                raise PackageError(f"{path}: __version__ {version!r} is not X.Y.Z[-pre-release]")
            return version
    raise PackageError(f"{path}: no __version__ = '<string>' at the top level")


def tag_version(environ: dict[str, str] | os._Environ[str] = os.environ) -> str | None:
    """The version a GitHub Actions run on a ``v*`` tag is releasing (``v0.1.0`` → ``0.1.0``), else ``None``."""
    name = environ.get("GITHUB_REF_NAME", "")
    if environ.get("GITHUB_REF_TYPE") == "tag" and name.startswith("v"):
        return name[1:]
    return None


def cmake_listed_files(cmake_text: str) -> tuple[set[str], set[str]]:
    """Return (scripts, resources) from a module ``CMakeLists.txt`` with ``${MODULE_NAME}`` expanded."""
    code = "\n".join(line.split("#", 1)[0] for line in cmake_text.splitlines())  # drop comments
    name = re.search(r"set\(\s*MODULE_NAME\s+(\S+?)\s*\)", code)
    if not name:
        raise PackageError("MODULE_NAME not set")
    lists: dict[str, set[str]] = {}
    for var, body in _SET_RE.findall(code):
        entries = (e.strip('"') for e in body.split())
        lists[var] = {e.replace("${MODULE_NAME}", name.group(1)) for e in entries if e}
    return lists.get("MODULE_PYTHON_SCRIPTS", set()), lists.get("MODULE_PYTHON_RESOURCES", set())


def module_tree_files(module_dir: Path) -> tuple[set[str], set[str]]:
    """Return (python files, other files) under ``module_dir`` as POSIX paths, minus build/cache files."""
    scripts: set[str] = set()
    resources: set[str] = set()
    for path in module_dir.rglob("*"):
        rel = path.relative_to(module_dir)
        # .DS_Store, editor files (git-ignored)
        hidden = any(part.startswith(".") for part in rel.parts)
        if path.is_dir() or hidden or _TREE_EXCLUDED_DIRS.intersection(rel.parts):
            continue
        if path.suffix in {".pyc", ".pyo"} or path.name == "CMakeLists.txt":
            continue
        (scripts if path.suffix == ".py" else resources).add(rel.as_posix())
    return scripts, resources


def cmake_tree_mismatch(module_dir: Path) -> list[str]:
    """Differences between the CMake lists and the module tree; empty when every file is listed exactly once."""
    listed_scripts, listed_resources = cmake_listed_files(
        (module_dir / "CMakeLists.txt").read_text(encoding="utf-8")
    )
    tree_scripts, tree_resources = module_tree_files(module_dir)
    problems = [f"not in SCRIPTS: {p}" for p in sorted(tree_scripts - listed_scripts)]
    problems += [f"not in RESOURCES: {p}" for p in sorted(tree_resources - listed_resources)]
    problems += [
        f"listed but missing: {p}"
        for p in sorted((listed_scripts | listed_resources) - (tree_scripts | tree_resources))
    ]
    problems += [
        f"python file in RESOURCES: {p}" for p in sorted(listed_resources) if p.endswith(".py")
    ]
    return problems


def module_files(module_dir: Path = MODULE_DIR) -> list[str]:
    """The module's files to ship (POSIX paths relative to ``module_dir``, sorted): the CMake lists, checked
    against the tree so a file that is not listed (and would be missing from the installed module) stops the
    build."""
    problems = cmake_tree_mismatch(module_dir)
    if problems:
        raise PackageError(
            f"{module_dir / 'CMakeLists.txt'} does not match the module tree: "
            + "; ".join(problems)
        )
    scripts, resources = cmake_listed_files(
        (module_dir / "CMakeLists.txt").read_text(encoding="utf-8")
    )
    files = sorted(scripts | resources)
    for rel in files:
        path = module_dir / rel
        if Path(rel).is_absolute() or ".." in Path(rel).parts or "\\" in rel:
            raise PackageError(f"unsafe path in CMakeLists.txt: {rel}")
        if any(p.is_symlink() for p in (path, *path.parents) if p.is_relative_to(module_dir)):
            raise PackageError(f"refusing to package a symlink: {rel}")
    return files


def zip_timestamp(environ: dict[str, str] | os._Environ[str] = os.environ) -> tuple[int, ...]:
    """The time of every entry: ``SOURCE_DATE_EPOCH`` (UTC, not before 1980) or 1980-01-01 00:00."""
    epoch = environ.get("SOURCE_DATE_EPOCH")
    if not epoch:
        return DEFAULT_TIMESTAMP
    if not epoch.isdigit():
        raise PackageError(f"SOURCE_DATE_EPOCH={epoch!r} is not a number of seconds")
    return max(DEFAULT_TIMESTAMP, tuple(time.gmtime(int(epoch))[:6]))


def build(
    output_dir: Path = DEFAULT_OUTPUT_DIR,
    *,
    module_dir: Path = MODULE_DIR,
    license_file: Path = LICENSE_FILE,
    version: str | None = None,
    timestamp: tuple[int, ...] = DEFAULT_TIMESTAMP,
) -> Path:
    """Write ``<output_dir>/RemoteView-<version>.zip`` and return its path (replaced atomically)."""
    version = version or read_version(module_dir / "remoteview_core" / "__init__.py")
    root = f"{ARCHIVE_PREFIX}-{version}"
    if license_file.is_symlink() or not license_file.is_file():
        raise PackageError(f"{license_file} is missing")
    entries = [(f"{root}/LICENSE.txt", license_file)]
    entries += [
        (f"{root}/{module_dir.name}/{rel}", module_dir / rel) for rel in module_files(module_dir)
    ]
    output_dir.mkdir(parents=True, exist_ok=True)
    target = output_dir / f"{root}.zip"
    fd, tmp_name = tempfile.mkstemp(prefix=f".{root}-", suffix=".zip", dir=output_dir)
    try:
        with os.fdopen(fd, "wb") as raw, zipfile.ZipFile(raw, "w") as archive:
            for name, source in entries:
                info = zipfile.ZipInfo(name, date_time=timestamp)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 3  # Unix, so external_attr carries the permissions
                info.external_attr = 0o100644 << 16  # regular file, rw-r--r--
                archive.writestr(info, source.read_bytes(), compresslevel=9)
        os.chmod(tmp_name, 0o644)  # mkstemp made it private; the zip is meant to be shared
        os.replace(tmp_name, target)
    except BaseException:
        Path(tmp_name).unlink(missing_ok=True)
        raise
    return target


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR, help="where to write the zip"
    )
    parser.add_argument(
        "--expect-version",
        help="fail unless __version__ is this (default: the v* tag in GitHub Actions)",
    )
    args = parser.parse_args(argv)
    try:
        version = read_version()
        expected = args.expect_version or tag_version()
        if expected is not None and expected != version:
            raise PackageError(
                f"the release is {expected} but {VERSION_FILE.relative_to(PLUGIN_ROOT.parent)} says "
                f"__version__ = {version!r}: set it to {expected!r} on main first"
            )
        target = build(args.output_dir, version=version, timestamp=zip_timestamp())
    except PackageError as exc:
        print(f"package.py: {exc}", file=sys.stderr)
        return 1
    with zipfile.ZipFile(target) as archive:
        count = len(archive.namelist())
    print(f"wrote {target} ({count} files, version {version})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
