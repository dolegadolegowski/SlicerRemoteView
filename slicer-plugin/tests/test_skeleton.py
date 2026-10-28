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
from mrml_fakes import EVENT_IDS

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
    "segment IDs",
    "models and segments",
    "colours",
    "opacity",
    "visibility",
    "transforms",
    "every change",
    "any scene you open or load",
    "does not take back what was already sent",
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
    # SLC-34: the flush timer is made, single-shot and idle; nothing observes the scene before Start
    flush = widget.flushTimer
    assert (
        flush.single_shot and not flush.active and flush.slots["timeout()"] == widget.onFlushTimer
    )
    scene = slicer_stubs["slicer"].mrmlScene
    assert not any(scene.HasObserver(event) for event in EVENT_IDS.values())
    assert {"remoteview_core.observers", "remoteview_core.live", "remoteview_core.ids"}.isdisjoint(
        sys.modules
    )
    for hook in ("enter", "exit"):  # Slicer calls these whenever the panel is shown/hidden
        if hasattr(widget, hook):
            getattr(widget, hook)()
    widget.cleanup()
    assert widget.logic is None
    for timer in (
        widget.pumpTimer,
        widget.flushTimer,
    ):  # stopped and disconnected: Reload frees the old widget
        assert not timer.active and "timeout()" not in timer.slots
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


# --------------------------------------------------------------------------- SLC-34: live changes in the adapter


#: The five ``vtkSegmentation`` events the adapter passes (SLC-36/37): ``MrmlEvents`` field → ``slicer.vtkSegmentation``
#: attribute → the id Slicer 5.12.4 is believed to give it (``[TODO verify]`` in Slicer: manual §13 step 1).
SEGMENTATION_EVENT_FIELDS = {
    "segment_added": ("SegmentAdded", 62102),
    "segment_removed": ("SegmentRemoved", 62103),
    "segment_modified": ("SegmentModified", 62104),
    "representation_modified": ("RepresentationModified", 62101),
    "representation_names_modified": ("ContainedRepresentationNamesModified", 62105),
}


def _made_watcher(import_remote_view, monkeypatch, sink) -> dict:
    """``makeWatcher(sink)`` with ``SceneWatcher`` replaced by a recorder: the keyword arguments it was built with."""
    from remoteview_core import observers  # noqa: PLC0415

    made = {}

    def record(sink, **kwargs):
        made.update(kwargs, sink=sink)
        return "watcher"

    monkeypatch.setattr(observers, "SceneWatcher", record)
    widget = import_remote_view().RemoteViewWidget(mock.MagicMock(name="parentWidget"))
    widget.setup()
    assert widget.makeWatcher(sink) == "watcher"
    widget.cleanup()
    return made


def test_skeleton_watcher_factory_uses_slicer_event_ids(
    import_remote_view, slicer_stubs, monkeypatch
):
    """Each Slicer constant lands in its own field (a swap would observe the wrong events silently)."""
    from remoteview_core import observers  # noqa: PLC0415
    from remoteview_core.mrml_scene import MrmlSceneApi  # noqa: PLC0415

    sink = object()
    made = _made_watcher(import_remote_view, monkeypatch, sink)
    assert made["sink"] is sink
    slicer = slicer_stubs["slicer"]
    assert made["events"] == observers.MrmlEvents(**EVENT_IDS)
    assert made["scene"] is slicer.mrmlScene
    assert made["nodes_by_class"] is slicer.util.getNodesByClass
    assert made["world_matrix"].__func__ is MrmlSceneApi.world_matrix


# --------------------------------------------------------------------------- SLC-37: segments in the adapter


def test_skeleton_watcher_factory_passes_the_five_segmentation_event_ids(
    import_remote_view, slicer_stubs, monkeypatch
):
    """``SegmentAdded``, ``SegmentRemoved``, ``SegmentModified``, ``RepresentationModified`` and
    ``ContainedRepresentationNamesModified`` each land in their own ``MrmlEvents`` field, read from the
    ``slicer.vtkSegmentation`` constants — never from a number written into the adapter."""
    events = _made_watcher(import_remote_view, monkeypatch, object())["events"]
    vtk_segmentation = slicer_stubs["slicer"].vtkSegmentation
    assert {field: getattr(events, field) for field in SEGMENTATION_EVENT_FIELDS} == {
        "segment_added": 62102,
        "segment_removed": 62103,
        "segment_modified": 62104,
        "representation_modified": 62101,
        "representation_names_modified": 62105,
    }
    for field, (attribute, _expected) in SEGMENTATION_EVENT_FIELDS.items():
        assert getattr(events, field) == getattr(vtk_segmentation, attribute)
    # the two events the watcher does not observe are in the stub too, and none of them is passed
    passed = {getattr(events, field) for field in SEGMENTATION_EVENT_FIELDS}
    assert vtk_segmentation.SourceRepresentationModified not in passed
    assert vtk_segmentation.SegmentsOrderModified not in passed


@pytest.mark.parametrize(
    "attribute", sorted(attribute for attribute, _ in SEGMENTATION_EVENT_FIELDS.values())
)
def test_skeleton_watcher_factory_never_guesses_a_segmentation_event_id(
    import_remote_view, slicer_stubs, monkeypatch, attribute
):
    """A Slicer build whose ``vtkSegmentation`` lacks one of the attributes fails loudly at Start (``AttributeError``),
    instead of observing an id the adapter made up."""
    monkeypatch.delattr(slicer_stubs["slicer"].vtkSegmentation, attribute)
    widget = import_remote_view().RemoteViewWidget(mock.MagicMock(name="parentWidget"))
    widget.setup()
    with pytest.raises(AttributeError):
        widget.makeWatcher(object())
    widget.cleanup()


def test_skeleton_scene_api_is_built_from_slicer_functions_only(
    import_remote_view, slicer_stubs, monkeypatch
):
    """``sceneApi()`` takes exactly ``(slicer.util.getNodesByClass, slicer.vtkMRMLFolderDisplayNode)``: segments need
    no segmentations logic (the adapter reads the representation the 3D view draws and never creates one)."""
    from remoteview_core import mrml_scene  # noqa: PLC0415

    made: list[tuple] = []

    def record(*args, **kwargs):
        made.append((args, kwargs))
        return "api"

    monkeypatch.setattr(mrml_scene, "MrmlSceneApi", record)
    module = import_remote_view()
    assert module.RemoteViewLogic.sceneApi() == "api"
    slicer = slicer_stubs["slicer"]
    assert made == [((slicer.util.getNodesByClass, slicer.vtkMRMLFolderDisplayNode), {})]


_MANUAL_STEP_RE = re.compile(r"§13[^;,.)|]*step (\d+)")


def test_skeleton_manual_section_13_exists_for_every_todo_verify_reference():
    """The ``[TODO verify]`` notes of the adapter and the core point at numbered steps of manual §13 (CLAUDE.md rule
    10): the section exists, is numbered, and holds every step they name."""
    manual = (PLUGIN_ROOT.parent / "docs" / "testing" / "slicer.md").read_text()
    section = re.search(r"^## §13 .*?(?=^## §)", manual, re.MULTILINE | re.DOTALL)
    assert section, "docs/testing/slicer.md has no §13"
    steps = {int(n) for n in re.findall(r"^(\d{1,2})\. \*\*", section.group(0), re.MULTILINE)}
    assert steps == set(range(1, 15)), f"§13 should number steps 1–14, found {sorted(steps)}"
    referenced = {
        int(n)
        for path in (*MODULE_DIR.rglob("*.py"), *(PLUGIN_ROOT / "tests").glob("*.py"))
        if "_vendor" not in path.parts
        for n in _MANUAL_STEP_RE.findall(path.read_text())
    }
    assert referenced and referenced <= steps, f"dangling §13 step references: {referenced - steps}"
    readme = (PLUGIN_ROOT / "README.md").read_text()
    assert "remoteview_core/ids.py" in readme and "slicer.vtkSegmentation" in readme


def test_skeleton_cleanup_stops_and_disconnects_both_timers_even_if_the_session_does_not_close(
    import_remote_view, caplog
):
    widget = import_remote_view().RemoteViewWidget(mock.MagicMock(name="parentWidget"))
    widget.setup()
    widget.controller = mock.MagicMock(name="controller")
    widget.controller.shutdown.side_effect = KeyError("vtkMRMLModelNode4 Doe^John")
    widget.pumpTimer.start()
    widget.flushTimer.start(150)
    with caplog.at_level("DEBUG"):
        widget.cleanup()  # entered from C++ on Reload: nothing may escape
    assert "RemoteView: session not closed (KeyError)" in caplog.text
    assert "vtkMRMLModelNode" not in caplog.text and "Doe" not in caplog.text
    assert widget.controller is None and widget.logic is None
    for timer in (widget.pumpTimer, widget.flushTimer):
        assert not timer.active and "timeout()" not in timer.slots
    widget.cleanup()  # Reload aborted, then exit: a second cleanup raises nothing


def test_skeleton_flush_and_pump_slots_log_only_the_type(import_remote_view, caplog):
    widget = import_remote_view().RemoteViewWidget(mock.MagicMock(name="parentWidget"))
    widget.setup()
    widget.controller = mock.MagicMock(name="controller")
    widget.controller.flush_live.side_effect = KeyError("vtkMRMLModelNode4 Doe^John")
    widget.controller.pump.side_effect = KeyError("vtkMRMLModelNode4 Doe^John")
    with caplog.at_level("DEBUG"):
        widget.onFlushTimer()  # Qt slots: an escaping exception would reach PyErr_Print (T7)
        widget.onPump()
    assert caplog.text.count("(KeyError)") == 2
    assert "RemoteView: scene changes not sent (KeyError)" in caplog.text
    assert "RemoteView: panel not updated (KeyError)" in caplog.text
    assert "vtkMRMLModelNode" not in caplog.text and "Doe" not in caplog.text


def test_skeleton_slots_without_a_controller_do_nothing(import_remote_view, caplog):
    widget = import_remote_view().RemoteViewWidget(mock.MagicMock(name="parentWidget"))
    widget.setup()
    widget.pumpTimer.start()
    with caplog.at_level("DEBUG"):
        widget.onFlushTimer()
        widget.onPump()
    assert caplog.text == "" and widget.controller is None
    assert not widget.pumpTimer.active  # a pump with nothing to pump stops
