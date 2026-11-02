"""Node identity for the GLB manifest and `scene.update` (``docs/protocol.md`` v1.1 §3.3, §7.3; report
``2026-10-27-protocol-2`` item 1; threat model T7).

:class:`SceneIds` is the publisher's raw ID → alias registry. Made by the panel for one session's ``LiveUpdates``,
which keeps it across a resume, and handed to every export and to the change classifier, it answers one question for
every entity the 3D view shows: what is its ``nodeId``?

- A model, or the segmentation node whose ID prefixes its segments, keeps its MRML ID only when the ID is what Slicer
  generates — a ``fullmatch`` of :data:`MRML_ID` (``vtkMRMLModelNode4``, ``vtkMRMLSegmentationNode12``). Any other
  string or ``bytes`` ID (``Sphere``, ``root``, a hand-edited ``.mrml``, an ID with ``/``) becomes ``m_<n>`` in both
  ``nodeId`` and ``mrmlId``, whether names are hidden or not: scripted and singleton IDs can be name-like, and an ID is
  repeated in every ``scene.update`` (T7). The namespaces ``m_<digits>`` and ``s_<digits>`` are reserved by §7.3; a raw
  ID of that shape does not match the contract regex and is aliased like any other.
- A segment's ``nodeId`` is ``<mrmlId>/<segmentId>`` verbatim only when the raw segment ID is a ``str`` inside
  :data:`SEGMENT_ID` — the §3.3 set **without** ``/``, stricter than §7.3 so that the ``<prefix>/<segment>`` split
  stays unambiguous —, is not itself ``s_<digits>``, keeps the ``nodeId`` within :data:`MAX_NODE_ID` characters and
  names are shown. Otherwise it is ``<mrmlId>/s_<n>``: ``bytes`` IDs (VTK returns ``bytes`` for a ``std::string``
  that is not UTF-8) are outside the set and always aliased. ``extras.segmentId`` carries the raw ID (``bytes`` decoded
  as UTF-8 with U+FFFD) or is omitted under *Hide node names*.
- One per-session counter per namespace, never repeating. The raw → alias maps live as long as the Slicer scene:
  :meth:`SceneIds.reset` (scene closed) clears them and keeps the counters, so an alias is never reissued within a
  session, and moves :attr:`SceneIds.generation`: a preparation in steps begun before the close stops at its next
  step with :class:`SceneClosedError` (SLC-68). An alias once issued is kept — also after *Hide node names* is
  switched off again (§7.3 "never reissued or shadowed" wins over "alias only when needed"): the segment is then
  exported under its alias with ``segmentId`` revealed.

Standard library only. No method puts a raw ID into an exception text or the ``repr`` (a raw segment ID may be PHI).
Main thread only (unsynchronised; the collection, the snapshot builder and the classifier share one instance and all
run on Slicer's main thread) — except :meth:`SceneIds.closed_elsewhere`, which moves the generation under a lock from
any thread (SLC-70).
"""

from __future__ import annotations

import re
import threading
from typing import Any

#: §7.3: the IDs Slicer generates (class name + counter). Used with ``fullmatch``.
MRML_ID = re.compile(r"vtkMRML[A-Za-z]+Node[0-9]+")
#: A segment ID exported verbatim: the §3.3 ``nodeId`` set without ``/`` (see the module docstring).
SEGMENT_ID = re.compile(r"[A-Za-z0-9_.:-]+")
#: The reserved alias namespaces (§7.3): a model or segmentation node, and a segment.
MODEL_ALIAS = re.compile(r"m_[0-9]+")
SEGMENT_ALIAS = re.compile(r"s_[0-9]+")
#: §3.3 ``nodeId`` length limit.
MAX_NODE_ID = 128


class SceneClosedError(RuntimeError):
    """The scene was closed (:meth:`SceneIds.reset`) while it was prepared: nothing of it may be read or sent (T7)."""


def is_generated_id(raw: Any) -> bool:
    """A ``str`` MRML ID of the shape Slicer generates (:data:`MRML_ID`, within :data:`MAX_NODE_ID` characters):
    the only raw ID that goes on the wire as it is (§7.3)."""
    return isinstance(raw, str) and len(raw) <= MAX_NODE_ID and MRML_ID.fullmatch(raw) is not None


class SceneIds:
    """The raw ID → alias registry of one session (see the module docstring)."""

    def __init__(self) -> None:
        self._models: dict[Any, str] = {}
        self._segments: dict[tuple[Any, Any], str] = {}
        self._next_m = 1
        self._next_s = 1
        #: the scene closes so far (:meth:`reset`, :meth:`closed_elsewhere`): a preparation started before one stops
        #: at its next step (SLC-68)
        self.generation = 0
        # closed_elsewhere runs off the main thread (SLC-70)
        self._generation_lock = threading.Lock()

    def model_node_id(self, raw: Any) -> str | None:
        """The ``nodeId``/``mrmlId`` of a model or segmentation node with MRML ID ``raw``: the ID itself when it is
        generated, else its ``m_<n>`` alias (allocated on first sight, then fixed); ``None`` when ``raw`` is neither a
        ``str`` nor ``bytes`` (an adapter bug, never a Slicer state — the caller skips the node)."""
        if is_generated_id(raw):
            return raw
        if not isinstance(raw, (str, bytes)):
            return None
        alias = self._models.get(raw)
        if alias is None:
            alias = f"m_{self._next_m}"
            self._next_m += 1
            self._models[raw] = alias
        return alias

    def segment_node_id(self, node_raw: Any, seg_raw: Any, *, anonymize: bool) -> str | None:
        """The ``nodeId`` of segment ``seg_raw`` of the segmentation node ``node_raw``: ``<mrmlId>/<seg_raw>`` when
        the raw ID may go verbatim, else ``<mrmlId>/s_<n>`` from the map (the raw object is the key); ``None`` when
        either raw ID is neither ``str`` nor ``bytes``."""
        mrml_id = self.model_node_id(node_raw)
        if mrml_id is None or not isinstance(seg_raw, (str, bytes)):
            return None
        key = (node_raw, seg_raw)
        alias = self._segments.get(key)
        if alias is not None:  # issued earlier: kept, also with names shown again (§7.3)
            return f"{mrml_id}/{alias}"
        if (
            not anonymize
            and isinstance(seg_raw, str)
            and SEGMENT_ID.fullmatch(seg_raw) is not None
            and SEGMENT_ALIAS.fullmatch(seg_raw) is None
            and len(mrml_id) + 1 + len(seg_raw) <= MAX_NODE_ID
        ):
            return f"{mrml_id}/{seg_raw}"
        alias = f"s_{self._next_s}"
        self._next_s += 1
        self._segments[key] = alias
        return f"{mrml_id}/{alias}"

    def segment_extra(self, seg_raw: Any, *, anonymize: bool) -> str | None:
        """``extras.segmentId``: ``None`` (omitted) under *Hide node names*, else the raw ID as a ``str`` (``bytes``
        decoded as UTF-8 with U+FFFD for the invalid bytes); ``None`` for a raw ID of another type."""
        if anonymize:
            return None
        if isinstance(seg_raw, bytes):
            return seg_raw.decode("utf-8", errors="replace")
        return seg_raw if isinstance(seg_raw, str) else None

    def held_prefix(self, node_raw: Any) -> str | None:
        """``"<mrmlId>/"`` — what every ``nodeId`` of the node's segments starts with — or ``None``."""
        mrml_id = self.model_node_id(node_raw)
        return None if mrml_id is None else f"{mrml_id}/"

    def reset(self) -> None:
        """The Slicer scene was closed: forget the raw → alias maps, keep counting (no alias is reissued), and move
        :attr:`generation`, which stops a preparation begun before the close (SLC-68)."""
        self._models.clear()
        self._segments.clear()
        with self._generation_lock:
            self.generation += 1

    def closed_elsewhere(self) -> None:
        """The scene was closed off the main thread (SLC-70): move :attr:`generation` only, so a preparation running
        now stops at its next step; the maps are the main thread's — the owner's :meth:`reset` clears them there
        before it uses them again. The one method safe on any thread."""
        with self._generation_lock:
            self.generation += 1

    def __repr__(self) -> str:
        return (
            f"SceneIds(models={len(self._models)}, segments={len(self._segments)}, "
            f"next_m={self._next_m}, next_s={self._next_s})"
        )
