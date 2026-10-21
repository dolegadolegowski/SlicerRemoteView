"""Shared pytest fixtures for ``slicer-plugin``.

3D Slicer is not available outside the application (CLAUDE.md rule 10), so ``RemoteView.py`` is imported
against stub ``slicer``/``qt``/``ctk`` modules. The stubs model only what the adapter touches; anything
Slicer-specific beyond that is verified manually (``docs/testing/slicer.md``).
"""

from __future__ import annotations

import importlib
import sys
import types
import unittest
import xml.etree.ElementTree as ET
from collections.abc import Iterator
from pathlib import Path
from typing import ClassVar
from unittest import mock

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
#: Directory of the scripted module; Slicer appends it to ``sys.path`` when it loads a non-embedded
#: scripted module (``Base/QTGUI/qSlicerScriptedLoadableModuleFactory.cxx``, tag v5.12.4).
MODULE_DIR = PLUGIN_ROOT / "RemoteView"

# Like Slicer, append the module directory to sys.path, so `remoteview_core` imports from the source tree.
if str(MODULE_DIR) not in sys.path:
    sys.path.append(str(MODULE_DIR))


class _ScriptedLoadableModule:
    """Mirror of ``slicer.ScriptedLoadableModule.ScriptedLoadableModule.__init__`` (5.12.4)."""

    def __init__(self, parent):
        self.parent = parent
        self.moduleName = type(self).__name__
        parent.title = ""
        parent.categories = []
        parent.dependencies = []
        parent.contributors = []
        parent.helpText = ""
        parent.acknowledgementText = ""


class _ScriptedLoadableModuleWidget:
    """Mirror of ``ScriptedLoadableModuleWidget`` (5.12.4): ``resourcePath`` resolves against the module directory."""

    def __init__(self, parent=None):
        self.moduleName = type(self).__name__.removesuffix("Widget")
        self.parent = parent if parent is not None else mock.MagicMock(name="qMRMLWidget")
        self.layout = self.parent.layout()
        if parent is None:  # like 5.12.4: a parentless widget sets itself up
            self.setup()

    def setup(self):
        pass

    def cleanup(self):
        pass

    def resourcePath(self, filename):
        return str(MODULE_DIR / "Resources" / filename)


class _ScriptedLoadableModuleLogic:
    def __init__(self, parent=None):
        self.moduleName = type(self).__name__.removesuffix("Logic")


class _ScriptedLoadableModuleTest(unittest.TestCase):
    def delayDisplay(self, message, requestedDelay=None, msec=None):
        pass


class _StubApp:
    """``slicer.app`` with ``connect`` and ``applicationVersion``. Slots deferred to ``startupCompleted()`` run
    immediately, so whatever they do happens inside the test (and its side-effect guard) instead of never."""

    applicationVersion = "5.12.4"

    def connect(self, signal: str, slot) -> None:
        if signal == "startupCompleted()":
            slot()


class _StubQTimer:
    """``qt.QTimer`` whose ``singleShot`` fires at once (deferred work must not escape the guard). Instances only
    record their interval, connections and state; tests call the connected slot themselves."""

    def __init__(self) -> None:
        self.interval: int | None = None
        self.slots: dict[str, object] = {}
        self.active = False

    @staticmethod
    def singleShot(_msec: int, callback) -> None:
        callback()

    def setInterval(self, msec: int) -> None:
        self.interval = msec

    def connect(self, signal: str, slot) -> None:
        self.slots[signal] = slot

    def start(self) -> None:
        self.active = True

    def stop(self) -> None:
        self.active = False

    def isActive(self) -> bool:
        return self.active


class _StubQFont:
    """The ``qt.QFont`` enum values the adapter uses."""

    Monospace = 7  # QFont::Monospace
    PercentageSpacing = 0  # QFont::PercentageSpacing


def _pip_ensure_signature(  # noqa: PLR0913, PLR0917 — mirrors Slicer's
    requirements,
    constraints=None,
    skip_packages=None,
    prompt_install=True,
    prompt_restart=True,
    requester=None,
    skip_in_testing=True,
    show_progress=True,
):
    """``slicer.packaging.pip_ensure`` in Slicer 5.12 (the body is Slicer's; only the signature matters here)."""


def _confirm_ok_cancel_display_signature(text, windowTitle=None, parent=None, **kwargs):
    """``slicer.util.confirmOkCancelDisplay`` in Slicer 5.12 (the extra keywords reach the message box)."""


class _StubQColor:
    def __init__(self, name: str) -> None:
        self.name = name


class _StubQPixmap:
    """``qt.QPixmap(width, height)``: remembers its size, its fills and the rectangles painted on it."""

    def __init__(self, width: int, height: int) -> None:
        self.size = (width, height)
        self.fills: list[str] = []
        self.rects: list[tuple[int, int, int, int, str]] = []
        self.painter: _StubQPainter | None = None

    def fill(self, color: _StubQColor) -> None:
        self.fills.append(color.name)

    def width(self) -> int:
        return self.size[0]

    def height(self) -> int:
        return self.size[1]

    def dark_modules(self, scale: int) -> set[tuple[int, int]]:
        """The (column, row) of every module painted dark, given the pixels per module."""
        return {
            (x // scale + i, y // scale)
            for x, y, width, height, color in self.rects
            if color == "black" and height == scale
            for i in range(width // scale)
        }


class _StubQPainter:
    def __init__(self, device: _StubQPixmap) -> None:
        self.device = device
        self.ended = False
        device.painter = self

    def fillRect(self, x: int, y: int, width: int, height: int, color: _StubQColor) -> None:
        assert not self.ended, "painting after end()"
        self.device.rects.append((x, y, width, height, color.name))

    def end(self) -> None:
        self.ended = True


def _make_application_class() -> type:
    class _StubClipboard:
        def __init__(self) -> None:
            self.text = ""

        def setText(self, text: str) -> None:
            self.text = text

    clipboard = _StubClipboard()

    class _StubQApplication:
        @staticmethod
        def clipboard() -> _StubClipboard:
            return clipboard

    return _StubQApplication


def ui_widget_names(path) -> list[str]:
    """``objectName`` of every widget, layout-free, in a Qt Designer ``.ui`` file."""
    root = ET.parse(path).getroot()  # noqa: S314 — the module's own .ui file, not external input
    return [w.get("name") for w in root.iter("widget") if w.get("name")]


def _make_settings_class() -> type:
    class _StubQSettings:
        """``qt.QSettings`` over one in-memory dict per stub set (Slicer's settings file in the application): each
        call of ``_make_settings_class`` runs this class body again, so every test gets a fresh ``store``."""

        store: ClassVar[dict[str, object]] = {}

        def value(self, key, default=None):
            return self.store.get(key, default)

        def setValue(self, key, value) -> None:
            self.store[key] = value

        def contains(self, key) -> bool:
            return key in self.store

    return _StubQSettings


def _load_ui(path):
    """``slicer.util.loadUI``: like Slicer, refuse a missing file; the stub widget remembers its ``.ui`` path."""
    if not Path(path).is_file():
        raise RuntimeError(f"Could not load UI file: file not found {path}")
    return mock.MagicMock(name="uiWidget", uiPath=str(path))


def _child_widget_variables(widget):
    """``slicer.util.childWidgetVariables``: one attribute per named widget of the ``.ui`` file — and no other, so an
    adapter that looks up a widget the file does not define fails the tests."""
    return types.SimpleNamespace(
        **{name: mock.MagicMock(name=name) for name in ui_widget_names(widget.uiPath)}
    )


def _strict_module(name: str, **attributes) -> types.ModuleType:
    """A module with exactly ``attributes``; any other attribute raises ``AttributeError``, so an adapter
    that starts using e.g. ``qt.QNetworkAccessManager`` fails the tests until the stub (and review) allow it."""
    module = types.ModuleType(name)
    for key, value in attributes.items():
        setattr(module, key, value)
    return module


def _make_stub_modules() -> dict[str, types.ModuleType]:
    slicer = types.ModuleType("slicer")
    slicer.app = _StubApp()

    settings_class = _make_settings_class()
    util = types.ModuleType("slicer.util")
    util.pip_install = mock.MagicMock(name="slicer.util.pip_install")
    # the user's answer to a confirmation dialog: yes unless a test says otherwise
    util.confirmOkCancelDisplay = mock.create_autospec(
        _confirm_ok_cancel_display_signature,
        name="slicer.util.confirmOkCancelDisplay",
        return_value=True,
    )
    util.loadUI = _load_ui
    util.childWidgetVariables = _child_widget_variables

    def settings_value(key, default, converter=lambda v: v, settings=None):
        settings = settings_class() if settings is None else settings
        return converter(settings.value(key)) if settings.contains(key) else default

    util.settingsValue = settings_value
    # an empty scene (MRML stays manual, docs/testing/slicer.md); tests replace these to add nodes
    util.getNodesByClass = lambda _class_name: []
    slicer.util = util
    slicer.vtkMRMLFolderDisplayNode = mock.NonCallableMagicMock(
        name="slicer.vtkMRMLFolderDisplayNode",
        spec_set=[
            "GetHierarchyVisibility",
            "GetHierarchyOpacity",
            "GetOverridingHierarchyDisplayNode",
        ],
    )

    packaging = types.ModuleType("slicer.packaging")
    packaging.pip_install = mock.MagicMock(name="slicer.packaging.pip_install")
    # the signature of Slicer 5.12.0-5.12.4 (Base/Python/slicer/packaging.py): a misspelt keyword fails the test
    packaging.pip_ensure = mock.create_autospec(
        _pip_ensure_signature, name="slicer.packaging.pip_ensure"
    )
    slicer.packaging = packaging

    slm = types.ModuleType("slicer.ScriptedLoadableModule")
    slm.ScriptedLoadableModule = _ScriptedLoadableModule
    slm.ScriptedLoadableModuleWidget = _ScriptedLoadableModuleWidget
    slm.ScriptedLoadableModuleLogic = _ScriptedLoadableModuleLogic
    slm.ScriptedLoadableModuleTest = _ScriptedLoadableModuleTest
    slicer.ScriptedLoadableModule = slm

    # Only the Qt classes the adapter uses; widgets are permissive mocks, network/process classes absent.
    qt = _strict_module(
        "qt",
        QFont=_StubQFont,
        QSettings=settings_class,
        QTimer=_StubQTimer,
        QPixmap=_StubQPixmap,
        QPainter=_StubQPainter,
        QColor=_StubQColor,
        QApplication=_make_application_class(),
    )
    ctk = _strict_module("ctk")
    return {
        "slicer": slicer,
        "slicer.util": util,
        "slicer.packaging": packaging,
        "slicer.ScriptedLoadableModule": slm,
        "qt": qt,
        "ctk": ctk,
    }


@pytest.fixture
def slicer_stubs(monkeypatch: pytest.MonkeyPatch) -> Iterator[dict[str, types.ModuleType]]:
    """Install stub ``slicer``/``qt``/``ctk`` modules and put the module directory on ``sys.path``.

    Everything is undone after the test (``monkeypatch``), including the imported ``RemoteView`` module.
    """
    stubs = _make_stub_modules()
    for name, module in stubs.items():
        monkeypatch.setitem(sys.modules, name, module)
    monkeypatch.delitem(sys.modules, "RemoteView", raising=False)
    yield stubs
    sys.modules.pop("RemoteView", None)


@pytest.fixture
def packages_installed(monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    """The distributions ``remoteview_core.deps`` sees as installed (name → version), at the pinned versions; a
    test edits the dict to model missing or other versions. Nothing is loaded in the session (no restart needed)."""
    from remoteview_core import deps  # noqa: PLC0415 — needs the module directory on sys.path (set above)

    versions = {p.name: p.version for p in deps.PACKAGES}
    monkeypatch.setattr(deps, "installed_version", versions.get)
    monkeypatch.setattr(deps, "loaded_version", lambda _name: None)
    return versions


@pytest.fixture
def fake():
    """``support.FakeTransport`` with a clean ``made`` list (the panel's transport factory in tests)."""
    from support import FakeTransport  # noqa: PLC0415 — imports remoteview_core, which needs the path set above

    FakeTransport.made = []
    return FakeTransport


@pytest.fixture
def import_remote_view(slicer_stubs: dict[str, types.ModuleType]):
    """Return a function that imports ``RemoteView.py`` against the stubs."""

    def _import() -> types.ModuleType:
        return importlib.import_module("RemoteView")

    return _import
