"""Each node's mesh as the last export made it (SLC-50; ``docs/research/slicer-prepare.md`` § Per-node cache).

A live re-export used to collect and decimate every node again: about 11 s on a 16M-triangle segmentation for any
change, one to a small model next to it too. :class:`MeshCache` keeps, per ``nodeId``, the mesh's :func:`mesh_stamp`,
the triangle count collect gave, the share it was fitted to and the fitted geometry (glTF), or why the export left it
out. The collection (``collect_steps(…, cache=)``) takes a node whose stamp is unchanged from it without collecting
it, and ``prepare_snapshot`` stores what it fits. Only what the export sent is kept: the fitted geometry (at most the
share), or the whole mesh of a node that fitted its share or that nothing could reduce — never a collected mesh that
was decimated.

- :func:`mesh_stamp`: the polydata's address and VTK modification times. VTK takes every modification time from one
  global counter, and a new object is stamped in its constructor, so an object at a reused address has a newer time.
  ``vtkPolyData::GetMTime()`` covers the points and the cell arrays but not the arrays inside a ``vtkCellArray``,
  which are added. The bake of a sheared matrix is part of the stamp; a non-linear chain is never cached (its
  transform is a new object at every read).
- A decimated result is used for the same share only; a node that was not decimated (it fitted its share) for any
  share it still fits, since its result does not depend on the share.

One cache per live session (``LiveUpdates``); the node IDs it keys by stay in memory and out of its repr (T7). Main
thread only (VTK objects are read).
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from numpy.typing import NDArray
from vtkmodules.vtkCommonDataModel import vtkPolyData

Stamp = tuple[Any, ...]


def mesh_stamp(polydata: Any, bake: Stamp | None = None) -> Stamp | None:
    """What identifies the mesh of ``polydata`` as it is now, with ``bake`` (the sheared world matrix baked into it, as
    a tuple, or ``None``); ``None`` for anything that is not a ``vtkPolyData`` (never cached)."""
    if not isinstance(polydata, vtkPolyData):
        return None
    times = [polydata.GetMTime()]
    for cells in (polydata.GetPolys(), polydata.GetStrips()):
        if cells is not None:
            times += [cells.GetConnectivityArray().GetMTime(), cells.GetOffsetsArray().GetMTime()]
    return (polydata.GetAddressAsString("vtkPolyData"), *times, bake)


@dataclass(frozen=True, eq=False)
class CachedMesh:
    """A node's mesh as the last export fitted it: ``count`` triangles collected, fitted to ``share`` — ``reduced``
    (decimated), ``unreduced`` (above its share, nothing could reduce it: kept whole) or neither (it fitted)."""

    stamp: Stamp = field(repr=False)
    count: int
    share: int
    positions: NDArray[np.float64] = field(repr=False)
    normals: NDArray[np.float32] = field(repr=False)
    indices: NDArray[np.int64] = field(repr=False)
    reduced: bool = False
    unreduced: bool = False

    def fits(self, share: int) -> bool:
        """Whether this result is the one a fit to ``share`` gives: the same share, or a node that was not decimated
        and still fits."""
        return share == self.share or (self.count <= share and self.count <= self.share)


@dataclass(frozen=True, eq=False)
class CachedSkip:
    """A node the export left out because of its mesh (``reason`` a ``collect.SkipReason``; ``baked`` as
    ``SkippedNode.baked``)."""

    stamp: Stamp = field(repr=False)
    reason: Any
    baked: bool = False


class MeshCache:
    """``nodeId`` → :class:`CachedMesh` or :class:`CachedSkip` (see the module docstring)."""

    def __init__(self) -> None:
        self._entries: dict[str, CachedMesh | CachedSkip] = {}

    def __repr__(self) -> str:  # counts only (T7)
        return f"MeshCache(nodes={len(self._entries)})"

    def __len__(self) -> int:
        return len(self._entries)

    def get(self, node_id: str, stamp: Stamp | None) -> CachedMesh | CachedSkip | None:
        """The entry of ``node_id`` if its mesh still has ``stamp``; ``None`` otherwise (and for no stamp)."""
        entry = self._entries.get(node_id)
        return entry if entry is not None and stamp is not None and entry.stamp == stamp else None

    def put(self, node_id: str, entry: CachedMesh | CachedSkip) -> None:
        self._entries[node_id] = entry

    def discard(self, node_id: str) -> None:
        self._entries.pop(node_id, None)

    def keep_only(self, node_ids: Iterable[str]) -> None:
        """Drop the entries of every node not in ``node_ids`` (the nodes the last preparation looked at)."""
        keep = set(node_ids)
        self._entries = {k: v for k, v in self._entries.items() if k in keep}

    def clear(self) -> None:
        """The scene was closed: none of its meshes comes back."""
        self._entries.clear()
