"""Pure-Python core of the RemoteView module (SlicerRemoteView extension).

Everything here runs without 3D Slicer: plain Python 3.12 + numpy (+ the ``vtk`` package for geometry
filters, never its Qt bindings). It must not import ``slicer``, ``qt``, ``ctk`` or ``RemoteView``
(``tests/test_core_purity.py``, CLAUDE.md rule 10); the Slicer adapter ``RemoteView.py`` calls into it.
Slicer puts the module directory on ``sys.path``, so this package imports as ``remoteview_core``.
"""

__version__ = "0.1.0"
