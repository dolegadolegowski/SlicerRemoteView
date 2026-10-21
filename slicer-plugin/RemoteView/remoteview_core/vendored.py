"""The vendored protocol package ``RemoteView/_vendor/remoteview_protocol`` (ADR 0007 §3, SLC-03).

``shared/`` does not exist next to an installed extension, so ``slicer-plugin/scripts/vendor_shared.py`` copies
``shared/py/remoteview_protocol`` into ``RemoteView/_vendor/``. Core modules reach it only through here::

    from remoteview_core.vendored import alphabet, chunk_header

How it is loaded: the package is registered in ``sys.modules`` from its file location **without executing its
``__init__``**. That ``__init__`` imports the schema validator, which needs ``jsonschema`` — not a Slicer runtime
dependency (FR-16 and architecture §8 T12 allow only ``websockets`` and ``segno``; decision in
``docs/plan/slicer.md`` Follow-ups). Submodules import normally from the vendored directory, so the stdlib-only
``chunk_header`` and ``alphabet`` work everywhere, and the tests (which have ``jsonschema``) can still import
``remoteview_protocol.schemas``/``envelope`` explicitly. ``_vendor`` is never put on ``sys.path``: nothing in it can
shadow another module, and a ``remoteview_protocol`` (package or submodule) loaded from anywhere else is refused.
Pure Python, no Slicer import.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

VENDOR_DIR = Path(__file__).resolve().parent.parent / "_vendor"
PACKAGE_NAME = "remoteview_protocol"
PACKAGE_DIR = VENDOR_DIR / PACKAGE_NAME


def _inside_package(module: ModuleType) -> bool:
    """True when ``module`` was loaded from :data:`PACKAGE_DIR` (by file, or by ``__path__`` for namespace dirs)."""
    file = getattr(module, "__file__", None)
    locations = [file] if file is not None else list(getattr(module, "__path__", None) or [])
    return bool(locations) and all(Path(p).resolve().is_relative_to(PACKAGE_DIR) for p in locations)


def _refuse_foreign() -> None:
    foreign = sorted(
        name
        for name, module in list(sys.modules.items())
        if (name == PACKAGE_NAME or name.startswith(PACKAGE_NAME + "."))
        and not _inside_package(module)
    )
    if foreign:
        raise ImportError(
            f"{', '.join(foreign)} imported from outside RemoteView/_vendor; the module must use its vendored copy"
        )


_refuse_foreign()
if PACKAGE_NAME not in sys.modules:
    if not (PACKAGE_DIR / "__init__.py").is_file():
        raise ImportError(
            f"vendored package missing at {PACKAGE_DIR}; run slicer-plugin/scripts/vendor_shared.py"
        )
    _spec = importlib.util.spec_from_file_location(
        PACKAGE_NAME, PACKAGE_DIR / "__init__.py", submodule_search_locations=[str(PACKAGE_DIR)]
    )
    # Deliberately not executed (see the module docstring); importlib.resources and submodule imports still work.
    sys.modules[PACKAGE_NAME] = importlib.util.module_from_spec(_spec)

from remoteview_protocol import alphabet, chunk_header  # noqa: E402 — stdlib-only submodules

_refuse_foreign()  # also covers the submodules just imported

__all__ = ["PACKAGE_DIR", "VENDOR_DIR", "alphabet", "chunk_header"]
