"""Display names for the GLB manifest (``docs/protocol.md`` §7.3, FR-15, threat model T7).

:func:`sanitize_name` turns a Slicer node or segment name into the sanitised form §7.3 requires: characters of
:data:`~remoteview_core.glb_writer.FORBIDDEN_NAME_CATEGORIES` are removed (the line-breaking ones become a space),
runs of whitespace collapse to one space, the result is trimmed and cut to 64 UTF-16 code units. 64 UTF-16 units
also means at most 64 code points, so the name fits §7.3 whether a viewer counts code points (Python) or UTF-16
units (JavaScript); the writer's :func:`~remoteview_core.glb_writer.is_valid_name` accepts every result.

:class:`NameAssigner` gives every exported entity its display name: the sanitised name, or with "Hide node names"
the substitutes ``Model <n>``/``Segment <n>`` that the writer accepts under ``anonymizedNames: true``. Standard library
plus the writer's constants — no Slicer, Qt or VTK import.
"""

from __future__ import annotations

import unicodedata

from remoteview_core.glb_writer import (
    FORBIDDEN_NAME_CATEGORIES,
    MAX_NAME_LENGTH,
    is_valid_name,
    utf16_length,
)

#: §7.3 "≤ 64 chars", counted in UTF-16 code units (an astral character counts twice) — the writer's
#: :func:`~remoteview_core.glb_writer.utf16_length` is the one counter (SLC-27).
MAX_NAME_UTF16_UNITS = MAX_NAME_LENGTH
_LABELS = {"model": "Model", "segment": "Segment"}
#: Regional indicator symbols: a flag is a pair, so a cut must not leave half of one.
_REGIONAL_INDICATORS = range(0x1F1E6, 0x1F200)


def _drop_broken_tail(kept: str, removed: str) -> str:
    """Repair the end of a cut name, given the first character the cut ``removed``: when the cut fell inside a
    combining sequence, the kept marks of that sequence go too; when it split a flag (a pair of regional
    indicators), the kept half goes."""
    if unicodedata.category(removed) in ("Mn", "Me"):
        while kept and unicodedata.category(kept[-1]) in ("Mn", "Me"):
            kept = kept[:-1]
    elif ord(removed) in _REGIONAL_INDICATORS:
        indicators = "".join(map(chr, _REGIONAL_INDICATORS))
        if (len(kept) - len(kept.rstrip(indicators))) % 2:
            kept = kept[:-1]
    return kept.rstrip()


def sanitize_name(raw: str | bytes | None) -> str:
    """The §7.3 display name for ``raw`` (``None`` — a node without a name — gives ``""``).

    ``bytes`` are what VTK's Python wrapping returns for a ``char*`` name that is not valid UTF-8 (e.g. from a
    legacy cp1250 file — verified with VTK 9.6.2: ``vtkFloatArray().SetName(b"P\\xb3uco")`` then ``GetName()``
    gives ``bytes``); they are decoded as UTF-8 with U+FFFD for the invalid bytes. Deterministic and idempotent; never
    returns a surrogate, control, format, private-use, unassigned or line/paragraph-separator character,
    leading/trailing whitespace or more than 64 UTF-16 code units.
    """
    if raw is None:
        return ""
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", errors="replace")
    if not isinstance(raw, str):
        raise TypeError("a node name is a str, bytes or None")
    kept: list[str] = []
    for ch in raw:
        if unicodedata.category(ch) not in FORBIDDEN_NAME_CATEGORIES:
            kept.append(ch)
        elif ch.isspace():  # tab, newline, U+2028/U+2029 …: keep the word boundary
            kept.append(" ")
    collapsed = " ".join("".join(kept).split())
    units = 0
    cut = len(collapsed)
    for index, ch in enumerate(collapsed):
        units += utf16_length(ch)
        if units > MAX_NAME_UTF16_UNITS:
            cut = index
            break
    name = (
        collapsed if cut == len(collapsed) else _drop_broken_tail(collapsed[:cut], collapsed[cut])
    )
    if not is_valid_name(name):  # cannot happen; keeps the writer's contract explicit
        raise ValueError("sanitised name violates §7.3")
    return name


def anonymous_name(kind: str, number: int) -> str:
    """The §7.3 substitute ``"Model <n>"``/``"Segment <n>"`` (``number`` ≥ 1)."""
    if kind not in _LABELS:
        raise ValueError("kind must be 'model' or 'segment'")
    if isinstance(number, bool) or not isinstance(number, int) or number < 1:
        raise ValueError("number must be an int ≥ 1")
    return f"{_LABELS[kind]} {number}"


class NameAssigner:
    """Names for the entities of one snapshot, numbered per kind in export order.

    With ``anonymize=True`` (*Hide node names*) every entity gets its substitute and no part of the Slicer name is
    kept in the display name (pair it with ``RootExtras(anonymized_names=True)``; segment IDs inside ``nodeId`` are
    a separate matter — report ``2026-10-18-slicer-3``, SLC-13). Otherwise an entity gets its sanitised name, or
    its substitute when nothing is left of the name after sanitising (an empty label helps no viewer); such a
    substitute is not checked against the real names, so a node literally named ``Model 2`` may share its label
    (``nodeId`` stays the key). Call :meth:`assign` only for entities that are exported, so the numbers have no gaps.
    """

    def __init__(self, *, anonymize: bool = False) -> None:
        self._anonymize = bool(anonymize)
        self._counts = dict.fromkeys(_LABELS, 0)

    @property
    def anonymize(self) -> bool:
        """Fixed for the snapshot: one GLB never mixes shown and hidden names."""
        return self._anonymize

    def assign(self, kind: str, raw: str | bytes | None) -> str:
        if kind not in _LABELS:
            raise ValueError("kind must be 'model' or 'segment'")
        self._counts[kind] += 1
        substitute = anonymous_name(kind, self._counts[kind])
        if self._anonymize:
            return substitute
        return sanitize_name(raw) or substitute
