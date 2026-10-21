"""Runtime dependencies on first use (SLC-10; FR-16, FR-02, T12).

``websockets`` (the relay connection, ADR 0009) and ``segno`` (the QR code, SLC-11) are not part of Slicer. They are
downloaded from PyPI only after the user has clicked *Start session* and confirmed a dialog that says what is installed
and why; nothing is installed at import, at module load or by the module's constructor (Extension Index opt-in rule,
``docs/research/slicer.md`` §1, §6). This module decides *what* is missing and runs the sequence; the Slicer calls —
the confirmation dialog and ``slicer.packaging.pip_ensure`` — are injected by ``RemoteView.py``, so the logic is tested
without Slicer and this file imports neither ``slicer``, ``websockets`` nor ``segno``.

Version policy (T12, ADR 0009 item 7): each package is pinned to the exact release the module is tested with
(``17.2.0`` and ``17.2+local`` are the release ``17.2``, as for pip's ``==``). A package that is installed in *another*
release — say ``websockets`` 16.0 from a different extension, or a newer 17.3 — counts as missing: the consent dialog
names the installed version and says it is replaced or downgraded. A release that is on disk but not the one already
imported into this Slicer session cannot be used before a restart (``Outcome.RESTART``).

Failures are reported with fixed texts, never with the installer's exception text: pip's messages can carry proxy URLs
with credentials. (Slicer itself prints pip's output to its Python console and application log — that is outside this
module.)
"""

from __future__ import annotations

import enum
import importlib
import importlib.metadata
import logging
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass

_log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Package:
    """A PyPI distribution the module needs, at the exact version it was tested with. ``module`` is the name it is
    imported under when that differs from the distribution name (``PyYAML`` → ``yaml``)."""

    name: str
    version: str
    purpose: str
    module: str = ""

    @property
    def requirement(self) -> str:
        return f"{self.name}=={self.version}"

    @property
    def module_name(self) -> str:
        return self.module or self.name


#: In the order the dialog lists them. ``websockets`` 17.2 is the tested release (ADR 0009 item 7; the transport
#: refuses a version below 15). ``segno`` 1.6.6 is the newest release when SLC-10 was written; SLC-11 tests against it.
PACKAGES: tuple[Package, ...] = (
    Package("websockets", "17.2", "the secure connection to the relay"),
    Package("segno", "1.6.6", "the QR code of the join link"),
)

CONFIRM_TITLE = "RemoteView — install Python packages"
DECLINED = (
    "Nothing was installed or changed. RemoteView needs these Python packages to connect to a relay; click Start "
    "session again to be asked once more."
)
FAILED = (
    "The Python packages could not be installed. Check the network connection and the proxy settings of this "
    "computer, or ask your IT department to allow pypi.org and files.pythonhosted.org. If Slicer cannot write to its "
    "Python folder, or a package is in use, restart Slicer first. Slicer's installation window and Python console show "
    "what pip reported. To install the packages by hand, see the section Offline installation of the Python "
    "packages in slicer-plugin/README.md on the RemoteView project page (linked in the module help), then click "
    "Start session again."
)
INCOMPLETE = (
    "The Python packages are still not available in the tested version after the installation. Check Slicer's "
    "Python console, or install them by hand as described in the section Offline installation of the Python "
    "packages in slicer-plugin/README.md on the RemoteView project page (linked in the module help), then click "
    "Start session again."
)
RESTART = (
    "The Python packages are in place, but this Slicer session already loaded another version of {names}. "
    "Restart Slicer, then click Start session again."
)


class Outcome(enum.Enum):
    READY = "ready"
    DECLINED = "declined"
    FAILED = "failed"
    RESTART = "restart"


@dataclass(frozen=True)
class DepsResult:
    """``outcome`` READY: carry on. Otherwise ``detail`` is a fixed English text for the panel (never empty: a
    result that stops the session without saying why is a bug, not a way to continue)."""

    outcome: Outcome
    detail: str = ""

    def __post_init__(self) -> None:
        if self.outcome is not Outcome.READY and not self.detail:
            raise ValueError("a result that stops the session needs a text")


def installed_version(name: str) -> str | None:
    """The version of the installed distribution ``name`` (its metadata on ``sys.path``), or ``None``."""
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def loaded_version(name: str) -> str | None:
    """The version of the module ``name`` in this Python session, or ``None`` when it has not been imported."""
    module = sys.modules.get(name)
    version = getattr(module, "__version__", None) if module is not None else None
    return version if isinstance(version, str) else None


def _release(version: str) -> tuple[int | str, ...]:
    """The release segment of ``version`` as pip's ``==`` sees it: a ``+local`` label does not count, ``17.02`` is
    ``17.2`` and ``17.2.0`` is ``17.2``. Pre-releases and other suffixes (``17.2rc1``) stay different."""
    segments = version.split("+", maxsplit=1)[0].split(".")
    # ASCII digits only (``"²".isdigit()`` is true, ``int("²")`` fails) and short enough for ``int``
    parts = [int(p) if p.isascii() and p.isdigit() and len(p) < 10 else p for p in segments]
    while len(parts) > 1 and parts[-1] == 0:
        parts.pop()
    return tuple(parts)


def _is_newer(installed: str, pinned: str) -> bool:
    """Whether the installed release is above the pinned one; ``False`` when either is not a plain dotted number."""
    a, b = _release(installed), _release(pinned)
    if not all(isinstance(part, int) for part in (*a, *b)):
        return False
    return a > b


def _satisfied(package: Package, version: str | None) -> bool:
    return version is not None and _release(version) == _release(package.version)


def missing_packages(
    packages: Sequence[Package] = PACKAGES,
    installed: Callable[[str], str | None] | None = None,
) -> list[Package]:
    """The ``packages`` not installed in exactly the pinned release (``installed``: :func:`installed_version`)."""
    installed = installed or installed_version
    return [p for p in packages if not _satisfied(p, installed(p.name))]


def stale_modules(
    packages: Sequence[Package] = PACKAGES,
    loaded: Callable[[str], str | None] | None = None,
) -> list[Package]:
    """The ``packages`` already imported in another release than the pinned one: only a restart replaces them
    (``loaded``: :func:`loaded_version`, asked by import name)."""
    loaded = loaded or loaded_version
    return [
        p
        for p in packages
        if (version := loaded(p.module_name)) is not None and not _satisfied(p, version)
    ]


def consent_text(
    missing: Sequence[Package], installed: Callable[[str], str | None] | None = None
) -> tuple[str, str]:
    """``(message, details)`` of the confirmation dialog for ``missing`` packages."""
    installed = installed or installed_version
    lines = [f"  • {p.name} {p.version} — {p.purpose}" for p in missing]
    changes = []
    for p in missing:
        if (version := installed(p.name)) is not None:
            verb = "downgraded" if _is_newer(version, p.version) else "replaced"
            joint = "to" if verb == "downgraded" else "by"
            changes.append(f"  • {p.name} {version} will be {verb} {joint} {p.version}")
    message = (
        "RemoteView needs these Python packages in the version it was tested with:\n\n"
        + "\n".join(lines)
    )
    if changes:
        message += (
            "\n\nInstalled now:\n"
            + "\n".join(changes)
            + "\nOther extensions that use these packages will get the tested version."
        )
    message += (
        "\n\nThey are downloaded from PyPI, or from the package index configured for pip (pypi.org by default), and "
        "installed into Slicer's Python environment. That server sees this computer's address and the Python and "
        "operating-system versions, nothing from your scene. Install now?"
    )
    return message, "\n".join(p.requirement for p in missing)


def ensure_runtime_deps(
    install: Callable[[list[str]], object],
    confirm: Callable[[str, str], bool],
    *,
    packages: Sequence[Package] = PACKAGES,
    installed: Callable[[str], str | None] | None = None,
    loaded: Callable[[str], str | None] | None = None,
) -> DepsResult:
    """Make sure ``packages`` are importable, asking before anything is installed.

    ``confirm(message, details)`` shows the dialog and returns whether the user agreed; ``install(requirements)``
    installs exact requirement strings (``slicer.packaging.pip_ensure`` in the application) and raises when it fails.
    Nothing is called when everything is in place. ``installed`` and ``loaded`` default to :func:`installed_version`
    and :func:`loaded_version`, looked up at the call.
    """
    installed = installed or installed_version
    missing = missing_packages(packages, installed)
    if missing:
        message, details = consent_text(missing, installed)
        if not confirm(message, details):
            return DepsResult(Outcome.DECLINED, DECLINED)
        try:
            install([p.requirement for p in missing])
        except Exception as exc:  # noqa: BLE001 — pip, Qt and OS errors alike become one fixed text
            _log.warning("deps: installation failed (%s)", type(exc).__name__)
            return DepsResult(Outcome.FAILED, FAILED)
        importlib.invalidate_caches()  # the packages were not on disk when the import system listed the directories
        if missing_packages(missing, installed):
            return DepsResult(Outcome.FAILED, INCOMPLETE)
    stale = stale_modules(packages, loaded)
    if stale:
        return DepsResult(Outcome.RESTART, RESTART.format(names=", ".join(p.name for p in stale)))
    return DepsResult(Outcome.READY)
