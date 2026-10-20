"""RemoteView — share the 3D Slicer scene with phones and Meta Quest headsets (SlicerRemoteView).

This file is the thin Slicer adapter (``docs/plan/slicer.md``): UI, MRML access and Qt timers only.
Everything testable without Slicer lives in the pure package ``remoteview_core`` next to it.

Startup rules (FR-02, Extension Index opt-in, ``docs/research/slicer.md`` §1 and §8): importing this
module or constructing ``RemoteView`` performs no network access, no subprocess and no pip install,
and imports nothing heavier than ``slicer``/``qt``. Runtime dependencies are imported lazily after the
user clicks *Start session* (SLC-09, SLC-10).
"""

import qt
from slicer.ScriptedLoadableModule import (
    ScriptedLoadableModule,
    ScriptedLoadableModuleLogic,
    ScriptedLoadableModuleTest,
    ScriptedLoadableModuleWidget,
)

#
# RemoteView
#


class RemoteView(ScriptedLoadableModule):
    """Module descriptor. Base class reference (Slicer 5.12.4):
    https://github.com/Slicer/Slicer/blob/v5.12.4/Base/Python/slicer/ScriptedLoadableModule.py
    """

    def __init__(self, parent):
        ScriptedLoadableModule.__init__(self, parent)
        self.parent.title = "RemoteView"
        self.parent.categories = ["Remote"]
        self.parent.dependencies = []
        self.parent.contributors = ["SlicerRemoteView contributors"]
        self.parent.helpText = """
Shows the 3D scene on phones, tablets and Meta Quest headsets that join with a 5-character code.
Nothing leaves this computer until you click <b>Start session</b>. From then on the relay server
shown in the panel receives: the surface meshes of the models and segments shown in 3D (no images
or volumes), their names (unless <i>Hide node names</i> is on) and MRML IDs, colours, opacity,
visibility and transforms, and the Slicer, extension and operating-system versions.
Anyone who has the code can view the scene while the session runs. Traffic is encrypted (TLS) on
the way to the relay, but the relay itself can read the scene (no end-to-end encryption).
The first Start asks before downloading the Python packages the module needs from PyPI.
See <a href="https://github.com/dolegadolegowski/SlicerRemoteView">the project page</a>.
"""
        self.parent.acknowledgementText = """
SlicerRemoteView. Module layout follows the 3D Slicer scripted module template.
"""


#
# RemoteViewWidget
#


class RemoteViewWidget(ScriptedLoadableModuleWidget):
    """Module panel. Placeholder until the session UI lands (SLC-09)."""

    def __init__(self, parent=None) -> None:
        # Set before the base __init__, which calls setup() itself when parent is None.
        self.logic = None
        ScriptedLoadableModuleWidget.__init__(self, parent)

    def setup(self) -> None:
        ScriptedLoadableModuleWidget.setup(self)
        self.logic = RemoteViewLogic()

        statusLabel = qt.QLabel(
            "RemoteView is not connected. Session controls arrive in a later version."
        )
        statusLabel.objectName = "statusLabel"
        statusLabel.wordWrap = True
        self.layout.addWidget(statusLabel)
        self.layout.addStretch(1)

    def cleanup(self) -> None:
        """Called when the module is unloaded (SLC-22 closes a running session here)."""
        self.logic = None


#
# RemoteViewLogic
#


class RemoteViewLogic(ScriptedLoadableModuleLogic):
    """Session logic. Placeholder: no state, no network until SLC-09."""

    def __init__(self) -> None:
        ScriptedLoadableModuleLogic.__init__(self)


#
# RemoteViewTest
#


class RemoteViewTest(ScriptedLoadableModuleTest):
    """Module self-test (Reload and Test). Extended to an export round trip in SLC-19."""

    def runTest(self):
        # No scene reset: this load test needs no data and must not discard the user's scene.
        self.test_ModuleLoads()

    def test_ModuleLoads(self):
        self.delayDisplay("Starting the RemoteView load test")
        logic = RemoteViewLogic()
        self.assertIsNotNone(logic)
        self.delayDisplay("RemoteView load test passed")
