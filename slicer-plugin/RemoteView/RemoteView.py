"""RemoteView — share the 3D Slicer scene with phones and Meta Quest headsets (SlicerRemoteView).

This file is the thin Slicer adapter (``docs/plan/slicer.md``): UI, MRML access and Qt timers only.
Everything testable without Slicer lives in the pure package ``remoteview_core`` next to it.

Startup rules (FR-02, Extension Index opt-in, ``docs/research/slicer.md`` §1 and §8): importing this
module or constructing ``RemoteView`` performs no network access, no subprocess and no pip install,
and imports nothing heavier than ``slicer``/``qt``. Runtime dependencies are imported lazily after the
user clicks *Start session* (SLC-09, SLC-10).
"""

import sys
import time

import qt
import slicer
from slicer.ScriptedLoadableModule import (
    ScriptedLoadableModule,
    ScriptedLoadableModuleLogic,
    ScriptedLoadableModuleTest,
    ScriptedLoadableModuleWidget,
)

#: QSettings keys (Slicer's own settings file): the relay address and the path of an additional CA certificate. Only
#: values the transport accepted are stored — a refused address may hold credentials (§3.1).
RELAY_URL_SETTING = "RemoteView/RelayURL"
EXTRA_CA_SETTING = "RemoteView/ExtraCACertificate"
#: No built-in relay until `deploy` names the production host (DEP-07) and `release` confirms it: a default address
#: would send data to whoever controls that name.
DEFAULT_RELAY_URL = ""
#: The main-thread pump that drains the transport's events (architecture §6, SLC-08 ADR 0009).
PUMP_INTERVAL_MS = 50

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
    """Module panel: Qt only. What Start/Stop do and what the panel shows is ``remoteview_core.panel`` (SLC-09)."""

    def __init__(self, parent=None) -> None:
        # Set before the base __init__, which calls setup() itself when parent is None.
        self.logic = None
        self.ui = None
        self.controller = None
        self.pumpTimer = None
        ScriptedLoadableModuleWidget.__init__(self, parent)

    def setup(self) -> None:
        ScriptedLoadableModuleWidget.setup(self)
        self.logic = RemoteViewLogic()

        uiWidget = slicer.util.loadUI(self.resourcePath("UI/RemoteView.ui"))
        self.layout.addWidget(uiWidget)
        self.ui = slicer.util.childWidgetVariables(uiWidget)

        codeFont = self.ui.codeLabel.font
        # "Courier New" from the .ui is not installed everywhere
        codeFont.setStyleHint(qt.QFont.Monospace)
        # 5 characters read aloud and retyped
        codeFont.setLetterSpacing(qt.QFont.PercentageSpacing, 130)
        self.ui.codeLabel.font = codeFont

        # the consent statement names the relay being typed, before anything is sent (R-06)
        self.ui.relayUrlLineEdit.connect("textChanged(QString)", self.onRelayUrlChanged)
        self.ui.relayUrlLineEdit.text = slicer.util.settingsValue(
            RELAY_URL_SETTING, DEFAULT_RELAY_URL
        )
        self.onRelayUrlChanged(self.ui.relayUrlLineEdit.text)
        caFile = slicer.util.settingsValue(EXTRA_CA_SETTING, "")
        self.ui.extraCaPathLineEdit.currentPath = caFile
        # A remembered extra trust anchor is never applied out of sight (T5): show the section that holds it.
        self.ui.advancedCollapsibleButton.collapsed = not caFile
        self.ui.startButton.connect("clicked(bool)", self.onStartClicked)
        self.ui.stopButton.connect("clicked(bool)", self.onStopClicked)

        self.pumpTimer = qt.QTimer()
        self.pumpTimer.setInterval(PUMP_INTERVAL_MS)
        self.pumpTimer.connect("timeout()", self.onPump)

    def cleanup(self) -> None:
        """Called when the module is unloaded: a running session is closed (waits up to 3 s)."""
        if self.pumpTimer is not None:
            self.pumpTimer.stop()
        if self.controller is not None:
            self.controller.shutdown()
        self.controller = None
        self.logic = None

    def onRelayUrlChanged(self, url: str) -> None:
        from remoteview_core.consent import consent_text  # noqa: PLC0415 — standard library only

        self.ui.consentLabel.text = consent_text(url)

    def onStartClicked(self, _checked: bool = False) -> None:
        # Imported only now: nothing of the session machinery is loaded before the user starts (FR-02).
        from remoteview_core.panel import PanelController  # noqa: PLC0415

        if self.controller is None:
            self.controller = PanelController(
                slicer_version=slicer.app.applicationVersion,
                platform=sys.platform,
                scene=self.logic.sceneApi,
                ensure_deps=self.ensureDependencies,
            )
        url = self.ui.relayUrlLineEdit.text.strip()
        caFile = self.ui.extraCaPathLineEdit.currentPath.strip()
        # the installation below runs Qt's event loop (dialogs, pip's progress window): no second click meanwhile
        self.ui.startButton.enabled = False
        try:
            view = self.controller.start(url, extra_ca_file=caFile or None)
        except Exception:
            # an error in a dialog or the installer must not leave Start disabled
            self.render(self.controller.view)
            raise
        if self.controller.active:  # the address and the CA file were accepted
            settings = qt.QSettings()
            settings.setValue(RELAY_URL_SETTING, url)
            settings.setValue(EXTRA_CA_SETTING, caFile)
            self.pumpTimer.start()
        self.render(view)

    def ensureDependencies(self):
        """Install the packages the session needs, after the user agrees (SLC-10, FR-16): the controller calls this
        once the relay address is accepted and before the transport starts."""
        from remoteview_core import deps  # noqa: PLC0415 — standard library only

        return deps.ensure_runtime_deps(self.logic.installPackages, self.confirmInstall)

    def confirmInstall(self, message: str, details: str) -> bool:
        from remoteview_core.deps import CONFIRM_TITLE  # noqa: PLC0415

        return slicer.util.confirmOkCancelDisplay(message, CONFIRM_TITLE, detailedText=details)

    def onStopClicked(self, _checked: bool = False) -> None:
        if self.controller is not None:
            self.render(self.controller.stop())

    def onPump(self) -> None:
        view = self.controller.pump()
        self.render(view)
        if not self.controller.active:
            self.pumpTimer.stop()
        # let the transport thread take the GIL (architecture §6, docs/research/slicer.md §3)
        time.sleep(0.001)

    def render(self, view) -> None:
        """Show a ``remoteview_core.panel.PanelView`` (plain-text labels only)."""
        self.ui.codeLabel.text = view.code
        self.ui.statusLabel.text = view.status
        self.ui.detailLabel.text = view.detail
        self.ui.startButton.enabled = view.start_enabled
        self.ui.stopButton.enabled = view.stop_enabled
        self.ui.relayUrlLineEdit.enabled = view.settings_enabled
        self.ui.extraCaPathLineEdit.enabled = view.settings_enabled


#
# RemoteViewLogic
#


class RemoteViewLogic(ScriptedLoadableModuleLogic):
    """Scene-side logic: the session lives in the panel's controller (SLC-09), which sends the scene this logic
    exposes as the session's first snapshot (SLC-25)."""

    def __init__(self) -> None:
        ScriptedLoadableModuleLogic.__init__(self)

    @staticmethod
    def installPackages(requirements) -> None:
        """Install exact ``requirements`` (``["websockets==17.2", …]``) with Slicer's pip support, which shows its own
        progress window and error dialog, and raise when pip fails. The user agreed in our dialog, so Slicer's generic
        one is off; our own result text covers a package that was loaded before (``prompt_restart=False``). Slicer
        5.12 (NFR-24) has ``slicer.packaging``; anything older fails with the fixed text of ``remoteview_core.deps``."""
        from slicer import packaging  # noqa: PLC0415 — Slicer's own module, imported at the first Start

        packaging.pip_ensure(
            requirements, prompt_install=False, prompt_restart=False, requester="RemoteView"
        )

    @staticmethod
    def sceneApi():
        """The current scene as ``remoteview_core.collect`` reads it: the model nodes the 3D view shows (SLC-22)."""
        from remoteview_core.mrml_scene import MrmlSceneApi  # noqa: PLC0415 — imports VTK

        return MrmlSceneApi(slicer.util.getNodesByClass, slicer.vtkMRMLFolderDisplayNode)


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
