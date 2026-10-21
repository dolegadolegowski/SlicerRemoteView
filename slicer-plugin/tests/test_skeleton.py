"""SLC-01: extension skeleton — import side effects (FR-02, R-06) and CMake file lists."""

from __future__ import annotations

import _socket
import ast
import importlib.metadata
import os
import re
import socket
import subprocess
import sys
import threading
import urllib.request
from pathlib import Path
from typing import NoReturn
from unittest import mock

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
MODULE_DIR = PLUGIN_ROOT / "RemoteView"

#: Runtime dependencies that must only be imported after the user clicks Start (FR-02, FR-16).
LAZY_MODULES = ("websockets", "segno", "jsonschema", "remoteview_protocol")
#: The module's own packages: re-imported inside the guard so cached imports cannot hide eager work.
PROJECT_PACKAGES = ("RemoteView", "remoteview_core", "remoteview_protocol")
#: Modules ``RemoteView.py`` may import while Slicer loads it (everything else only inside functions); ``sys`` and
#: ``time`` are built into the interpreter (already loaded, no import-time work).
IMPORT_ALLOWLIST = {"__future__", "ctk", "logging", "os", "qt", "slicer", "sys", "time"}
#: Words the help text must contain so the consent statement names what is sent (NFR-16, T7).
DISCLOSURE_WORDS = (
    "Start session",
    "surface meshes",
    "names",
    "Hide node names",
    "colours",
    "opacity",
    "visibility",
    "transforms",
    "Anyone who has the code",
    "PyPI",
)
_SOCKET_FUNCTIONS = (
    "socket",
    "create_connection",
    "getaddrinfo",
    "gethostbyname",
    "gethostbyname_ex",
    "gethostbyaddr",
    "getfqdn",
)
_OS_PROCESS_FUNCTIONS = tuple(
    name
    for name in dir(os)
    if name in {"system", "popen", "posix_spawn", "posix_spawnp", "startfile"}
    or name.startswith(("spawn", "exec"))
)


# BaseException, so a broad `except Exception` in the module cannot swallow it.
class ForbiddenSideEffectError(BaseException):
    pass


#: Every forbidden call is also recorded, so a broad ``except BaseException`` cannot hide it either.
_CALLS: list[str] = []


def _forbid(what: str):
    def _raise(*_args, **_kwargs):
        _CALLS.append(what)
        raise ForbiddenSideEffectError(f"{what} called while importing/constructing the module")

    return _raise


def _not_installed(name: str) -> NoReturn:
    raise importlib.metadata.PackageNotFoundError(name)


@pytest.fixture
def no_side_effects(monkeypatch: pytest.MonkeyPatch, slicer_stubs):
    """Make every network, DNS, process and pip entry point raise and record the call."""
    _CALLS.clear()
    for name in _SOCKET_FUNCTIONS:
        monkeypatch.setattr(socket, name, _forbid(f"socket.{name}"))
    monkeypatch.setattr(_socket, "socket", _forbid("_socket.socket"))
    for name in _OS_PROCESS_FUNCTIONS:
        monkeypatch.setattr(os, name, _forbid(f"os.{name}"))
    monkeypatch.setattr(subprocess, "Popen", _forbid("subprocess.Popen"))
    monkeypatch.setattr(urllib.request, "urlopen", _forbid("urllib.request.urlopen"))
    slicer = slicer_stubs["slicer"]
    monkeypatch.setattr(slicer.util, "pip_install", _forbid("slicer.util.pip_install"))
    monkeypatch.setattr(slicer.packaging, "pip_install", _forbid("slicer.packaging.pip_install"))
    monkeypatch.setattr(slicer.packaging, "pip_ensure", _forbid("slicer.packaging.pip_ensure"))
    # asking the user anything (the install consent included) waits for Start session
    monkeypatch.setattr(
        slicer.util, "confirmOkCancelDisplay", _forbid("slicer.util.confirmOkCancelDisplay")
    )
    # a fresh Slicer: the runtime packages are not installed, whatever the development environment has — a panel
    # that ran the dependency sequence while opening would then reach the forbidden calls above
    monkeypatch.setattr(importlib.metadata, "version", _not_installed)
    # Forget runtime dependencies and the project's own modules, so whatever RemoteView.py pulls in at import
    # (also transitively through remoteview_core) is imported afresh inside the guard; restored afterwards.
    watched = (*LAZY_MODULES, *PROJECT_PACKAGES)
    for loaded in list(sys.modules):
        if loaded.split(".")[0] in watched:
            monkeypatch.delitem(sys.modules, loaded)
    yield _CALLS
    # Modules first imported inside the guard belong to the discarded package objects; drop them so later tests
    # import fresh copies (monkeypatch then restores the original entries).
    for loaded in list(sys.modules):
        if loaded.split(".")[0] in watched:
            del sys.modules[loaded]


@pytest.mark.parametrize("remembered", [False, True], ids=["fresh", "remembered-relay"])
def test_skeleton_import_and_construct_have_no_side_effects(
    no_side_effects, import_remote_view, slicer_stubs, remembered
):
    # SLC-09: setup() restores these; opening the panel must still connect nothing (FR-02)
    if remembered:
        settings = slicer_stubs["qt"].QSettings()
        settings.setValue("RemoteView/RelayURL", "wss://relay.example.org/ws")
        settings.setValue("RemoteView/ExtraCACertificate", "/etc/hospital-root.pem")
    threads_before = set(threading.enumerate())
    before = set(sys.modules)
    module = import_remote_view()
    extra = {
        m
        for m in set(sys.modules) - before
        if m != "RemoteView" and not m.startswith("remoteview_core")
    }
    assert extra == set(), f"RemoteView.py imported extra modules: {sorted(extra)}"

    parent = mock.MagicMock(name="qSlicerScriptedLoadableModule")
    module.RemoteView(parent)
    assert parent.title == "RemoteView"
    assert parent.categories == ["Remote"]
    missing = [w for w in DISCLOSURE_WORDS if w not in parent.helpText]
    assert missing == [], f"help text does not disclose: {missing}"  # Extension Index opt-in

    widget = module.RemoteViewWidget(mock.MagicMock(name="parentWidget"))
    widget.setup()
    assert isinstance(widget.logic, module.RemoteViewLogic)
    for hook in ("enter", "exit"):  # Slicer calls these whenever the panel is shown/hidden
        if hasattr(widget, hook):
            getattr(widget, hook)()
    widget.cleanup()
    assert widget.logic is None
    parentless = module.RemoteViewWidget()  # Slicer calls setup() from the base __init__ here
    assert isinstance(parentless.logic, module.RemoteViewLogic)

    imported = [name for name in sys.modules if name.split(".")[0] in LAZY_MODULES]
    assert imported == [], f"runtime dependencies imported eagerly: {imported}"
    assert no_side_effects == [], f"forbidden calls (possibly swallowed): {no_side_effects}"
    new_threads = set(threading.enumerate()) - threads_before
    assert new_threads == set(), f"background work started before Start: {new_threads}"


def test_skeleton_side_effect_guard_detects_calls(no_side_effects, slicer_stubs):
    """The guard itself works, so the test above would fail for a module that connects or pip-installs."""
    with pytest.raises(ForbiddenSideEffectError):
        socket.create_connection(("relay.example", 443))
    with pytest.raises(ForbiddenSideEffectError):
        socket.gethostbyname("relay.example")
    with pytest.raises(ForbiddenSideEffectError):
        subprocess.run(["true"], check=False)
    with pytest.raises(ForbiddenSideEffectError):
        os.system("true")  # noqa: S605 — guarded: the patched os.system raises
    with pytest.raises(ForbiddenSideEffectError):
        sys.modules["slicer"].util.pip_install("websockets")
    # the install consent is a call the opened panel must not make, and the fixture reports a fresh Slicer
    with pytest.raises(ForbiddenSideEffectError):
        sys.modules["slicer"].util.confirmOkCancelDisplay("Install?")
    with pytest.raises(importlib.metadata.PackageNotFoundError):
        importlib.metadata.version("websockets")
    try:  # a swallowed call is still recorded
        sys.modules["slicer"].packaging.pip_ensure(["segno"])
    except Exception:  # noqa: BLE001, S110 — `except Exception` cannot catch the guard
        pass
    except ForbiddenSideEffectError:
        pass
    assert "slicer.packaging.pip_ensure" in no_side_effects
    qt = slicer_stubs["qt"]
    with pytest.raises(AttributeError):
        qt.QNetworkAccessManager  # noqa: B018 — strict stub: network/process Qt classes do not exist
    with pytest.raises(ForbiddenSideEffectError):  # deferred work runs inside the guard
        slicer_stubs["slicer"].app.connect("startupCompleted()", socket.socket)
    with pytest.raises(ForbiddenSideEffectError):
        qt.QTimer.singleShot(0, socket.socket)


def _import_time_modules(source: str) -> set[str]:
    """Top-level package names imported when the module body runs (function bodies excluded)."""
    found: set[str] = set()

    def visit(node: ast.AST) -> None:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            return
        if isinstance(node, ast.Import):
            found.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            found.add((node.module or ".").split(".")[0] if node.level == 0 else ".")
        for child in ast.iter_child_nodes(node):
            visit(child)

    visit(ast.parse(source))
    return found


def test_skeleton_import_time_modules_are_allowlisted():
    imported = _import_time_modules((MODULE_DIR / "RemoteView.py").read_text())
    assert imported <= IMPORT_ALLOWLIST, (
        f"heavy or network imports at load: {imported - IMPORT_ALLOWLIST}"
    )
    # The scanner sees imports hidden in try/if/class bodies, and ignores function bodies.
    sample = "try:\n    import segno\nexcept ImportError:\n    segno = None\n"
    sample += "class A:\n    import websockets\ndef f():\n    import subprocess\n"
    assert _import_time_modules(sample) == {"segno", "websockets"}


def test_skeleton_self_test_class_runs_against_stubs(import_remote_view):
    module = import_remote_view()
    case = module.RemoteViewTest()
    case.runTest()  # the load test instantiates the logic; it never clears the user's scene


# --- CMake lists ---------------------------------------------------------------------------------

_SET_RE = re.compile(
    r"set\(\s*(MODULE_PYTHON_SCRIPTS|MODULE_PYTHON_RESOURCES)\s+(.*?)\)", re.DOTALL
)
_TREE_EXCLUDED_DIRS = {"__pycache__", ".pytest_cache", ".ruff_cache"}


def cmake_listed_files(cmake_text: str) -> tuple[set[str], set[str]]:
    """Return (scripts, resources) from a module ``CMakeLists.txt`` with ``${MODULE_NAME}`` expanded."""
    code = "\n".join(line.split("#", 1)[0] for line in cmake_text.splitlines())  # drop comments
    name = re.search(r"set\(\s*MODULE_NAME\s+(\S+?)\s*\)", code)
    assert name, "MODULE_NAME not set"
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
        hidden = any(
            part.startswith(".") for part in rel.parts
        )  # .DS_Store, editor files (git-ignored)
        if path.is_dir() or hidden or _TREE_EXCLUDED_DIRS.intersection(rel.parts):
            continue
        if path.suffix in {".pyc", ".pyo"} or path.name == "CMakeLists.txt":
            continue
        (scripts if path.suffix == ".py" else resources).add(rel.as_posix())
    return scripts, resources


def cmake_tree_mismatch(module_dir: Path) -> list[str]:
    listed_scripts, listed_resources = cmake_listed_files(
        (module_dir / "CMakeLists.txt").read_text()
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


def test_skeleton_cmake_lists_every_module_file():
    assert cmake_tree_mismatch(MODULE_DIR) == []


def test_skeleton_cmake_mismatch_is_detected(tmp_path: Path):
    module_dir = tmp_path / "RemoteView"
    (module_dir / "Resources" / "Icons").mkdir(parents=True)
    (module_dir / "RemoteView.py").write_text("")
    (module_dir / "Resources" / "Icons" / "RemoteView.png").write_bytes(b"")
    (module_dir / "extra.py").write_text("")
    (module_dir / "Resources" / "extra.json").write_text("{}")
    (module_dir / ".DS_Store").write_bytes(b"")  # hidden files are ignored
    (module_dir / "CMakeLists.txt").write_text(
        "set(MODULE_NAME RemoteView)\n"
        "# set(MODULE_PYTHON_SCRIPTS commented.py)\n"
        'set(MODULE_PYTHON_SCRIPTS\n  ${MODULE_NAME}.py "gone.py"\n  )\n'
        "set(MODULE_PYTHON_RESOURCES\n  Resources/Icons/${MODULE_NAME}.png # icon\n  extra.py\n  )\n"
    )
    assert cmake_tree_mismatch(module_dir) == [
        "not in SCRIPTS: extra.py",
        "not in RESOURCES: Resources/extra.json",
        "listed but missing: gone.py",
        "python file in RESOURCES: extra.py",
    ]


def test_skeleton_extension_cmake_metadata():
    text = (PLUGIN_ROOT / "CMakeLists.txt").read_text()
    assert re.search(r"^project\(SlicerRemoteView\)", text, re.MULTILINE)
    assert re.search(r'^set\(EXTENSION_CATEGORY "Remote"\)', text, re.MULTILINE)
    assert re.search(r'^set\(EXTENSION_HOMEPAGE "https://', text, re.MULTILINE)
    assert re.search(r"^add_subdirectory\(RemoteView\)", text, re.MULTILINE)
    module_cmake = (MODULE_DIR / "CMakeLists.txt").read_text()
    code = "\n".join(line.split("#", 1)[0] for line in module_cmake.splitlines())
    macro = re.search(r"slicerMacroBuildScriptedModule\((.*?)\)", code, re.DOTALL)
    assert macro, "slicerMacroBuildScriptedModule call missing"
    args = macro.group(1).split()
    for pair in (
        ["NAME", "${MODULE_NAME}"],
        ["SCRIPTS", "${MODULE_PYTHON_SCRIPTS}"],
        ["RESOURCES", "${MODULE_PYTHON_RESOURCES}"],
    ):
        i = args.index(pair[0])
        assert args[i : i + 2] == pair, f"macro must receive {pair}"
    assert "WITH_GENERIC_TESTS" in args
