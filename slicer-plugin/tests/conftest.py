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
from collections.abc import Iterator
from pathlib import Path
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


class _ScriptedLoadableModuleLogic:
    def __init__(self, parent=None):
        self.moduleName = type(self).__name__.removesuffix("Logic")


class _ScriptedLoadableModuleTest(unittest.TestCase):
    def delayDisplay(self, message, requestedDelay=None, msec=None):
        pass


class _StubApp:
    """``slicer.app`` with only ``connect``. Slots deferred to ``startupCompleted()`` run immediately, so
    whatever they do happens inside the test (and its side-effect guard) instead of never."""

    def connect(self, signal: str, slot) -> None:
        if signal == "startupCompleted()":
            slot()


class _StubQTimer:
    """``qt.QTimer`` whose ``singleShot`` fires at once (deferred work must not escape the guard)."""

    @staticmethod
    def singleShot(_msec: int, callback) -> None:
        callback()


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

    util = types.ModuleType("slicer.util")
    util.pip_install = mock.MagicMock(name="slicer.util.pip_install")
    slicer.util = util

    packaging = types.ModuleType("slicer.packaging")
    packaging.pip_install = mock.MagicMock(name="slicer.packaging.pip_install")
    packaging.pip_ensure = mock.MagicMock(name="slicer.packaging.pip_ensure")
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
        QIcon=mock.MagicMock(name="qt.QIcon"),
        QLabel=mock.MagicMock(name="qt.QLabel"),
        QTimer=_StubQTimer,
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
def import_remote_view(slicer_stubs: dict[str, types.ModuleType]):
    """Return a function that imports ``RemoteView.py`` against the stubs."""

    def _import() -> types.ModuleType:
        return importlib.import_module("RemoteView")

    return _import
