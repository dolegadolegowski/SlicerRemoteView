"""SLC-02: ``remoteview_core`` stays pure — no Slicer, Qt or CTK import (CLAUDE.md rule 10).

The pure package must run in the sandbox and in CI without 3D Slicer; only ``RemoteView.py`` (the adapter) may
touch Slicer. The check is an **allowlist**: the standard library, numpy, VTK without its Qt modules, the module's own
packages and the declared runtime dependencies. Anything else — ``slicer``, ``qt``, ``ctk``, ``vtkSegmentationCore``,
``MRMLCorePython``, ``qSlicer*``, ``vtkmodules.vtkGUISupportQt`` … — fails, statically or as a literal dynamic import.
"""

from __future__ import annotations

import ast
import json
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest

import remoteview_core

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
CORE_DIR = PLUGIN_ROOT / "RemoteView" / "remoteview_core"

#: Third-party/top-level packages the core may import (FR-16: websockets, segno at runtime after consent).
ALLOWED_PACKAGES = frozenset(
    {"numpy", "vtk", "vtkmodules", "remoteview_core", "remoteview_protocol", "websockets", "segno"}
)
_DYNAMIC_IMPORTERS = frozenset({"import_module", "__import__"})


def _is_forbidden(module: str) -> bool:
    parts = module.split(".")
    top = parts[0]
    if top in ("vtk", "vtkmodules"):
        # VTK is fine for geometry filters; its Qt bindings (vtkmodules.qt, vtkGUISupportQt, …) are not.
        return any(p == "qt" or "Qt" in p for p in parts[1:])
    return top not in ALLOWED_PACKAGES and top not in sys.stdlib_module_names


def forbidden_imports(source: str) -> list[str]:
    """Return the forbidden modules a source file imports (static, or dynamic with a literal module name)."""
    tree = ast.parse(source)
    importers = set(_DYNAMIC_IMPORTERS)
    for node in ast.walk(tree):  # aliases such as `from importlib import import_module as im`
        if isinstance(node, ast.ImportFrom) and node.module == "importlib":
            importers.update(a.asname or a.name for a in node.names if a.name == "import_module")
    found: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found += [a.name for a in node.names if _is_forbidden(a.name)]
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            # `from vtkmodules import qt` imports vtkmodules.qt
            candidates = [node.module] + [f"{node.module}.{a.name}" for a in node.names]
            found += [c for c in candidates if _is_forbidden(c)][:1]
        elif isinstance(node, ast.Call):
            func = node.func
            name = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")
            if name in importers:
                args = list(node.args[:1]) + [k.value for k in node.keywords if k.arg == "name"]
                found += [
                    a.value
                    for a in args
                    if isinstance(a, ast.Constant)
                    and isinstance(a.value, str)
                    and _is_forbidden(a.value)
                ]
    return found


def test_core_purity_package_imports_and_has_version():
    project = tomllib.loads((PLUGIN_ROOT / "pyproject.toml").read_text())["project"]
    assert remoteview_core.__version__ == project["version"]
    assert Path(remoteview_core.__file__).parent == CORE_DIR


def test_core_purity_requirements_contain_every_direct_pin():
    """requirements-dev.txt is compiled from the `dev` extra; a pin changed in only one file fails here."""
    project = tomllib.loads((PLUGIN_ROOT / "pyproject.toml").read_text())["project"]
    lines = {
        line.split(";")[0].strip()
        for line in (PLUGIN_ROOT / "requirements-dev.txt").read_text().splitlines()
        if line and not line.startswith(("#", "-"))
    }
    missing = [pin for pin in project["optional-dependencies"]["dev"] if pin not in lines]
    assert missing == []
    assert "--only-binary :all:" in (PLUGIN_ROOT / "requirements-dev.txt").read_text().splitlines()


#: Every core module, imported on its own in a fresh interpreter by the test below.
CORE_MODULES = [
    "remoteview_core",
    *sorted(f"remoteview_core.{p.stem}" for p in CORE_DIR.glob("*.py") if p.stem != "__init__"),
]
_IMPORT_PROBE = """
import importlib, json, socket, sys, threading
sys.path.append(sys.argv[1])
created = []
class _Socket(socket.socket):
    def __init__(self, *args, **kwargs):
        created.append(args)
        super().__init__(*args, **kwargs)
socket.socket = _Socket
importlib.import_module(sys.argv[2])
watched = {"websockets", "segno", "jsonschema", "slicer", "qt", "ctk"}
print(json.dumps([sorted({m.split(".")[0] for m in sys.modules} & watched), threading.active_count(), len(created)]))
"""


@pytest.mark.parametrize("module", CORE_MODULES)
def test_core_purity_import_starts_nothing(module):
    """FR-02/FR-16: importing a core module loads no runtime dependency (``websockets``, ``segno``, ``jsonschema``) and
    no Slicer/Qt, opens no socket and starts no thread — all of that waits for *Start session* (branch audit)."""
    result = subprocess.run(
        [sys.executable, "-I", "-c", _IMPORT_PROBE, str(CORE_DIR.parent), module],
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr[-2000:]
    assert json.loads(result.stdout) == [[], 1, 0]


def test_core_purity_no_slicer_qt_imports_in_remoteview_core():
    files = sorted(CORE_DIR.rglob("*.py"))
    assert files, "remoteview_core has no Python files"
    offenders = {
        str(f.relative_to(CORE_DIR)): bad
        for f in files
        if (bad := forbidden_imports(f.read_text()))
    }
    assert offenders == {}


@pytest.mark.parametrize(
    "source",
    [
        "import slicer",
        "import qt",
        "import ctk",
        "from slicer.util import pip_install",
        "import vtkSegmentationCore",
        "import vtkSlicerSegmentationsModuleLogicPython",
        "import MRMLCorePython",
        "import qSlicerSegmentationsModuleWidgetsPythonQt",
        "import vtkAddon",
        "import vtkITK",
        "import sitkUtils",
        "import SampleData",
        "import DICOMLib",
        "import PythonQt",
        "import vtkmodules.qt.QVTKRenderWindowInteractor",
        "from vtkmodules import qt",
        "from vtkmodules.vtkGUISupportQt import QVTKOpenGLNativeWidget",
        "import vtkmodules.vtkRenderingQt",
        "from vtk.qt import QVTKRenderWindowInteractor",
        "def f():\n    import slicer\n",
        "try:\n    import qt\nexcept ImportError:\n    qt = None\n",
        "import importlib\nimportlib.import_module('slicer')",
        "import importlib\nimportlib.import_module(name='qt')",
        "from importlib import import_module as im\nim('slicer')",
        "__import__('qt')",
        "import RemoteView",
        "import requests",
    ],
)
def test_core_purity_detects_forbidden_imports(source):
    assert forbidden_imports(source), source


@pytest.mark.parametrize(
    "source",
    [
        "import numpy as np",
        "import vtk",
        "from vtkmodules.vtkFiltersCore import vtkTriangleFilter",
        "from vtkmodules.util.numpy_support import vtk_to_numpy",
        "import json, struct, threading, ssl",
        "from remoteview_core import coords",
        "from remoteview_protocol.chunk_header import chunkify",
        "from . import glb_writer",
        "import importlib\nimportlib.import_module('remoteview_protocol')",
    ],
)
def test_core_purity_allows_pure_imports(source):
    assert forbidden_imports(source) == []


def _imports_protocol_package(source: str) -> bool:
    for node in ast.walk(ast.parse(source)):
        names = []
        if isinstance(node, ast.Import):
            names = [a.name for a in node.names]
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names = [node.module]
        elif isinstance(node, ast.Call):
            func = node.func
            callee = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")
            if callee in ("import_module", "__import__", "find_spec", "spec_from_file_location"):
                args = list(node.args[:1]) + [k.value for k in node.keywords if k.arg == "name"]
                names = [str(a.value) for a in args if isinstance(a, ast.Constant)]
        if any(n == "remoteview_protocol" or n.startswith("remoteview_protocol.") for n in names):
            return True
    return False


def test_core_purity_protocol_only_through_vendored():
    """SLC-03: core modules reach the protocol package only via `remoteview_core.vendored`, which pins the vendored
    copy and the jsonschema-free mode used in Slicer."""
    offenders = [
        f.name
        for f in sorted(CORE_DIR.rglob("*.py"))
        if f.name != "vendored.py" and _imports_protocol_package(f.read_text())
    ]
    assert offenders == []
    assert _imports_protocol_package("from remoteview_protocol.chunk_header import chunkify")
    assert _imports_protocol_package(
        "import importlib\nimportlib.import_module('remoteview_protocol.envelope')"
    )
    assert _imports_protocol_package(
        "import importlib as il\nil.import_module(name='remoteview_protocol.envelope')"
    )
    assert not _imports_protocol_package("from remoteview_core.vendored import chunk_header")
    assert not _imports_protocol_package(
        'raise RuntimeError("remoteview_protocol.schemas needs jsonschema")'
    )
