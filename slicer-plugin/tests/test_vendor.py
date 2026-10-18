"""SLC-03: vendored ``shared/py`` (ADR 0007 §3) — drift check, Node/Python parity, import isolation."""

from __future__ import annotations

import importlib
import importlib.util
import shutil
import subprocess
import sys
import types
from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PLUGIN_ROOT.parent
MODULE_DIR = PLUGIN_ROOT / "RemoteView"
SCRIPT = PLUGIN_ROOT / "scripts" / "vendor_shared.py"
VENDORED = MODULE_DIR / "_vendor" / "remoteview_protocol"
SHARED_SOURCE = REPO_ROOT / "shared" / "py" / "remoteview_protocol"


def _load_script() -> types.ModuleType:
    spec = importlib.util.spec_from_file_location("vendor_shared", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


VENDOR = _load_script()
HAS_NODE = VENDOR.find_node() is not None  # Node 22, decided exactly as the wrapper does
MODES = [pytest.param(["--python"], id="python")] + (
    [pytest.param([], id="node")]
    if HAS_NODE
    else [pytest.param([], id="node", marks=pytest.mark.skip("no Node 22"))]
)


def _run(*args: str | Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *map(str, args)],
        capture_output=True,
        text=True,
        check=False,
        timeout=120,
    )


def _python(code: str) -> subprocess.CompletedProcess[str]:
    """Run ``code`` in a fresh isolated interpreter with the module directory on sys.path (like Slicer) and
    nothing from ``shared/`` reachable."""
    prelude = (
        "import sys; from pathlib import Path\n"
        "sys.path[:] = [p for p in sys.path if not Path(p).resolve().is_relative_to(sys.argv[2])]\n"
        "sys.path.append(sys.argv[1])\n"
    )
    return subprocess.run(
        [sys.executable, "-I", "-c", prelude + code, str(MODULE_DIR), str(REPO_ROOT / "shared")],
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )


# --------------------------------------------------------------------------- drift check (criterion 1)


@pytest.mark.parametrize("mode", MODES)
def test_vendor_check_passes_on_the_committed_tree(mode):
    result = _run("--check", *mode)
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize(
    "mutate",
    [
        pytest.param(
            lambda d: (d / "alphabet.py").write_bytes((d / "alphabet.py").read_bytes() + b"#"),
            id="byte",
        ),
        pytest.param(lambda d: (d / "schema" / "ping.schema.json").unlink(), id="missing"),
        pytest.param(lambda d: (d / "extra.py").write_text(""), id="extra"),
        pytest.param(lambda d: (d / "VENDORED.json").write_text("{}\n"), id="manifest"),
        pytest.param(  # one byte that text-mode reads with newline translation would not see
            lambda d: (d / "VENDORED.json").write_bytes(
                (d / "VENDORED.json").read_bytes().replace(b"\n", b"\r", 1)
            ),
            id="manifest-cr",
        ),
    ],
)
def test_vendor_check_fails_after_a_change(mode, mutate, tmp_path):
    target = tmp_path / "remoteview_protocol"
    shutil.copytree(VENDORED, target)
    assert _run("--check", "--target", target, *mode).returncode == 0
    mutate(target)
    result = _run("--check", "--target", target, *mode)
    assert result.returncode == 1, result.stdout + result.stderr
    # the node id really ran the canonical tool (its hint names vendor-py.mjs), the python id the port
    assert ("vendor_shared.py" if mode else "vendor-py.mjs") in result.stderr


@pytest.mark.parametrize("mode", MODES)
def test_vendor_check_ignores_dot_files_like_node(mode, tmp_path):
    target = tmp_path / "remoteview_protocol"
    shutil.copytree(VENDORED, target)
    (target / ".DS_Store").write_bytes(b"\0")
    assert _run("--check", "--target", target, *mode).returncode == 0


def test_vendor_find_node_requires_node_22(monkeypatch):
    def fake_run(version):
        return lambda *_a, **_k: subprocess.CompletedProcess(
            [], 0, stdout=f"{version}\n", stderr=""
        )

    monkeypatch.setattr(VENDOR.shutil, "which", lambda _name: "/usr/bin/node")
    monkeypatch.setattr(VENDOR.subprocess, "run", fake_run("v22.12.0"))
    assert VENDOR.find_node() == "/usr/bin/node"
    monkeypatch.setattr(VENDOR.subprocess, "run", fake_run("v20.11.0"))
    assert VENDOR.find_node() is None


# --------------------------------------------------------------------------- copy (Node and the Python port)


def test_vendor_python_port_writes_the_node_manifest_byte_for_byte(tmp_path):
    """The committed VENDORED.json was written by shared/scripts/vendor-py.mjs; the port reproduces it."""
    manifest = (VENDORED / "VENDORED.json").read_bytes()
    assert VENDOR.manifest_text(SHARED_SOURCE).encode("utf-8") == manifest
    target = tmp_path / "remoteview_protocol"
    (target / "stale").mkdir(parents=True)
    shutil.copytree(VENDORED, target, dirs_exist_ok=True)
    (target / "stale.py").write_text("")
    (target / "envelope.py").write_text("broken")
    assert _run("--python", "--target", target).returncode == 0
    assert not (target / "stale.py").exists() and not (target / "stale").exists()
    for path in sorted(VENDORED.rglob("*")):
        if path.is_file() and "__pycache__" not in path.parts:
            assert (target / path.relative_to(VENDORED)).read_bytes() == path.read_bytes(), path


@pytest.mark.parametrize("mode", MODES)
def test_vendor_copy_refuses_foreign_targets(mode, tmp_path):
    """Copy mode deletes files not in the source — with either tool it must refuse an unrelated directory."""
    victim = tmp_path / "victim"
    (victim / "sub").mkdir(parents=True)
    (victim / "notes.txt").write_text("keep me")
    (victim / "sub" / "thesis.docx").write_text("keep me")
    result = _run("--target", victim, *mode)
    assert result.returncode != 0 and "refusing to vendor" in result.stderr
    assert (victim / "notes.txt").exists() and (victim / "sub" / "thesis.docx").exists()


@pytest.mark.parametrize("mode", MODES)
def test_vendor_copy_refuses_a_non_vendored_package_directory(mode, tmp_path):
    """Even a directory named remoteview_protocol is refused unless it is empty or carries VENDORED.json."""
    target = tmp_path / "remoteview_protocol"
    target.mkdir()
    (target / "mine.py").write_text("keep me")
    assert _run("--target", target, *mode).returncode != 0
    assert (target / "mine.py").exists()


def _symlink(link: Path, to: Path, *, directory: bool = False) -> None:
    try:
        link.symlink_to(to, target_is_directory=directory)
    except OSError:  # Windows without Developer Mode
        pytest.skip("cannot create symlinks here")


@pytest.mark.parametrize("mode", MODES)
def test_vendor_copy_and_check_never_follow_symlinks(mode, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "data.txt").write_text("keep me")
    (tmp_path / "outside.py").write_text("keep me too")
    target = tmp_path / "remoteview_protocol"
    shutil.copytree(VENDORED, target)
    _symlink(target / "cache", outside, directory=True)
    (target / "alphabet.py").unlink()
    _symlink(target / "alphabet.py", tmp_path / "outside.py")
    (target / "VENDORED.json").unlink()
    _symlink(target / "VENDORED.json", tmp_path / "outside.py")
    check = _run("--check", "--target", target, *mode)
    assert check.returncode == 1 and "symlinks" in check.stderr and "alphabet.py" in check.stderr
    assert _run("--target", target, *mode).returncode == 0
    assert (outside / "data.txt").read_text() == "keep me"  # the directory link was not followed
    assert (
        tmp_path / "outside.py"
    ).read_text() == "keep me too"  # nothing was written through the file link
    assert not (target / "alphabet.py").is_symlink() and not (target / "VENDORED.json").is_symlink()
    assert _run("--check", "--target", target, *mode).returncode == 0


# --------------------------------------------------------------------------- import isolation (criterion 2)


def test_vendor_import_uses_only_the_vendored_copy():
    """Like Slicer (module directory on sys.path), the protocol comes from RemoteView/_vendor only; the package
    __init__ (which needs jsonschema) is not executed and _vendor never goes on sys.path."""
    result = _python(
        "from remoteview_core.vendored import PACKAGE_DIR, VENDOR_DIR, alphabet, chunk_header\n"
        "import remoteview_protocol, ssl\n"
        "assert remoteview_protocol.__file__.startswith(str(PACKAGE_DIR))\n"
        "assert alphabet.__file__.startswith(str(PACKAGE_DIR)) and chunk_header.__file__.startswith(str(PACKAGE_DIR))\n"
        "assert not hasattr(remoteview_protocol, 'compile_schemas') and 'jsonschema' not in sys.modules\n"
        "assert str(VENDOR_DIR) not in sys.path and not ssl.__file__.startswith(str(VENDOR_DIR))\n"
        "assert alphabet.is_code('7KQ4X') and chunk_header.CHUNK_HEADER_BYTES == 12\n"
        "from remoteview_protocol import envelope, chunk_header, alphabet  # plan criterion 2 (tests have jsonschema)\n"
        "from remoteview_protocol.schemas import compile_schemas, validate_message\n"
        "assert validate_message(envelope.make('ping'), None, compile_schemas()) == []\n"
        "print(envelope.PROTOCOL_VERSION)\n"
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "1.0"


def test_vendor_works_without_jsonschema():
    """In Slicer jsonschema is not installed (FR-16, T12): the core still loads; only the schemas do not."""
    result = _python(
        "sys.modules['jsonschema'] = None  # import jsonschema → ImportError\n"
        "from remoteview_core import vendored as v\n"
        "assert [i for i, _ in v.chunk_header.chunkify(bytes(70000), 65536)] == [0, 1]\n"
        "assert v.alphabet.normalize_code(' 7kq4x ') == '7KQ4X'\n"
        "import importlib; importlib.reload(v)  # re-executing the accessor is harmless\n"
        "try:\n"
        "    import remoteview_protocol.schemas\n"
        "except ImportError:\n"
        "    print('no-schemas')\n"
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "no-schemas"


@pytest.mark.parametrize(
    ("name", "file", "path"),
    [
        ("remoteview_protocol", str(SHARED_SOURCE / "__init__.py"), None),
        (
            "remoteview_protocol.schema",
            None,
            [str(VENDORED / "schema"), str(SHARED_SOURCE / "schema")],
        ),  # mixed
        ("remoteview_protocol.alphabet", str(SHARED_SOURCE / "alphabet.py"), None),
        (
            "remoteview_protocol.schema",
            None,
            [str(SHARED_SOURCE / "schema")],
        ),  # namespace dir elsewhere
        ("remoteview_protocol.chunk_header", None, None),  # no location at all
    ],
)
def test_vendor_rejects_foreign_modules(monkeypatch, name, file, path):
    """A `remoteview_protocol` package or submodule from anywhere else (e.g. left in sys.modules by an import of a
    shared/py checkout) is refused, so the core can never run mixed code."""
    foreign = types.ModuleType(name)
    foreign.__file__ = file
    if path is not None:
        foreign.__path__ = path
    monkeypatch.setitem(sys.modules, name, foreign)
    monkeypatch.delitem(sys.modules, "remoteview_core.vendored", raising=False)
    with pytest.raises(
        ImportError, match=rf"{name.replace('.', '[.]')} imported from outside RemoteView/_vendor"
    ):
        importlib.import_module("remoteview_core.vendored")


def test_vendor_accepts_its_own_namespace_subpackage():
    """`remoteview_protocol.schema` (the JSON directory, no __init__) is a namespace module without a file."""
    result = _python(
        "import importlib\n"
        "from remoteview_core import vendored\n"
        "import remoteview_protocol.schema as s\n"
        "assert s.__file__ is None\n"
        "importlib.reload(vendored)\n"
        "print('ok')\n"
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "ok"


def test_vendor_unrelated_import_errors_are_not_swallowed():
    """A broken vendored file fails loudly."""
    result = _python(
        "import builtins\n"
        "real = builtins.__import__\n"
        "def fake(name, *a, **k):\n"
        "    if name == 'remoteview_protocol' and a and a[2] and 'chunk_header' in a[2]:\n"
        "        raise ImportError('boom')\n"
        "    return real(name, *a, **k)\n"
        "builtins.__import__ = fake\n"
        "import remoteview_core.vendored\n"
    )
    assert result.returncode != 0 and "boom" in result.stderr


def test_vendor_missing_package_is_reported_clearly(tmp_path):
    shutil.copytree(MODULE_DIR / "remoteview_core", tmp_path / "RemoteView" / "remoteview_core")
    result = subprocess.run(
        [
            sys.executable,
            "-I",
            "-c",
            "import sys; sys.path.append(sys.argv[1]); import remoteview_core.vendored",
            str(tmp_path / "RemoteView"),
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )
    assert result.returncode != 0 and "vendored package missing" in result.stderr
