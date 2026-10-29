"""RemoteView — share the 3D Slicer scene with phones and Meta Quest headsets (SlicerRemoteView).

This file is the thin Slicer adapter (``docs/plan/slicer.md``): UI, MRML access and Qt timers only.
Everything testable without Slicer lives in the pure package ``remoteview_core`` next to it.

Startup rules (FR-02, Extension Index opt-in, ``docs/research/slicer.md`` §1 and §8): importing this
module or constructing ``RemoteView`` performs no network access, no subprocess and no pip install,
and imports nothing heavier than ``slicer``/``qt``. Runtime dependencies are imported lazily after the
user clicks *Start session* (SLC-09, SLC-10).
"""

import logging
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

_log = logging.getLogger(__name__)

#: QSettings keys (Slicer's own settings file): the relay address and the path of an additional CA certificate. Only
#: values the transport accepted are stored — a refused address may hold credentials (§3.1).
RELAY_URL_SETTING = "RemoteView/RelayURL"
EXTRA_CA_SETTING = "RemoteView/ExtraCACertificate"
#: *Remove small islands* (SLC-54): on unless the user turned it off (the owner's request). Saved at every toggle — a
#: boolean holds no secret — and read with ``slicer.util.toBool``, which takes a stored ``"false"`` string too.
REMOVE_ISLANDS_SETTING = "RemoteView/RemoveSmallIslands"
#: When changes go out (SLC-57): the key of a ``remoteview_core.sendmode.SEND_MODES`` entry, chosen on the toolbar and
#: saved at every change; an unknown value is the default mode.
SEND_MODE_SETTING = "RemoteView/SendMode"
#: NFR-30: the QR code in the panel is at least 240 × 240 px (``remoteview_core.links.MIN_QR_PIXELS``, repeated here
#: so that nothing but ``qt`` and ``slicer`` is imported when the module loads).
MIN_QR_PIXELS = 240
#: No built-in relay until `deploy` names the production host (DEP-07) and `release` confirms it: a default address
#: would send data to whoever controls that name.
DEFAULT_RELAY_URL = ""
#: The main-thread pump that drains the transport's events (architecture §6, SLC-08 ADR 0009).
PUMP_INTERVAL_MS = 50
#: The code of the Presentation window, in points (NFR-29: readable from 2 m on a 24" screen needs ≥ 48 pt), and the
#: size of its QR code in pixels (the panel's own is the 240 px of NFR-30).
PRESENTATION_CODE_POINTS = 64
PRESENTATION_QR_PIXELS = 480
#: How long *Copy link* says "Link copied".
COPIED_FEEDBACK_MS = 1500
#: The Presentation window's hint, with and without a QR code to scan.
SCAN_HINT = "Scan the QR code with a phone camera, or open the viewer and type the code."
TYPE_HINT = "Open the viewer and type the code."
#: Shown under the status when the link exists but its QR code cannot be drawn.
QR_NOT_DRAWN = "The QR code could not be drawn. Read the code out or use Copy link."

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
or volumes), their names (unless <i>Hide node names</i> is on), MRML IDs and segment IDs, colours,
opacity, visibility and transforms, and the Slicer, extension and operating-system versions. While a
session runs, the relay also receives every change to these models and segments, including ones
shown, added or renamed later and any scene you open or load, until you click <b>Stop session</b>.
Hiding, deleting or renaming a model or segment does not take back what was already sent.
Anyone who has the code can view the scene while the session runs. Traffic is encrypted (TLS) on
the way to the relay, but the relay itself can read the scene (no end-to-end encryption).
The first Start asks before downloading the Python packages the module needs from PyPI.
See <a href="https://github.com/dolegadolegowski/SlicerRemoteView">the project page</a>.
"""
        self.parent.acknowledgementText = """
SlicerRemoteView. Module layout follows the 3D Slicer scripted module template.
"""
        # the toolbar (SLC-57) once the main window exists, like SampleData's menu (Slicer 5.12.4 SampleData.py L102)
        if not slicer.app.commandOptions().noMainWindow:
            slicer.app.connect("startupCompleted()", self.addToolbar)

    def addToolbar(self) -> None:
        """Slicer started: the *Send scene now* button and the send mode on the main window, before the panel is ever
        opened. A failure is logged by type only; the panel makes the toolbar when it opens, if it can."""
        try:
            sendToolbar()
        except Exception as exc:  # noqa: BLE001 — a Qt slot (T7)
            _log.error("RemoteView: toolbar not added (%s)", type(exc).__name__)


#
# SendToolbar
#

_toolbar = None  # the one SendToolbar of this module object (a Reload makes a new module object and a new toolbar)


def sendToolbar():
    """The toolbar of this Slicer run, made on first use (``None`` without a main window)."""
    global _toolbar  # noqa: PLW0603 — one toolbar per module object, like Slicer's own module-level state
    if _toolbar is None:
        window = slicer.util.mainWindow()
        if window is not None:
            _toolbar = SendToolbar(window)
    return _toolbar


class SendToolbar:
    """*Send scene now* and the send mode on Slicer's main window (SLC-57): the button sends the waiting changes (or the
    scene again) and counts down while they wait; the mode is saved at every change and reaches the panel's controller,
    live or not. The panel widget registers itself on ``widget`` while it exists; without it (the panel never opened,
    or no session) the button opens the panel. One per Slicer run: a toolbar of a previous module object (Reload) is
    removed first. ``[TODO verify]`` in Slicer 5.12.4: ``addToolBar``/``removeToolBar`` on the main window,
    ``QToolBar.addAction(str)`` returning the action, and ``QComboBox.currentIndex`` from PythonQt (manual §16)."""

    OBJECT_NAME = "RemoteViewToolBar"

    def __init__(self, window) -> None:
        from remoteview_core import sendmode  # noqa: PLC0415 — standard library and the debouncer only

        self.widget = None
        for old in window.findChildren("QToolBar"):
            if old.objectName == self.OBJECT_NAME:
                window.removeToolBar(old)
                old.deleteLater()
        self.toolbar = qt.QToolBar("RemoteView", window)
        self.toolbar.objectName = self.OBJECT_NAME
        self.sendAction = self.toolbar.addAction(sendmode.SEND_NOW)
        self.sendAction.toolTip = sendmode.SEND_NOW_TIP
        self.sendAction.enabled = False
        self.sendAction.connect("triggered()", self.onSendNow)
        label = qt.QLabel(sendmode.MODE_LABEL)
        label.toolTip = sendmode.MODE_TIP
        self.toolbar.addWidget(label)
        self.modeBox = qt.QComboBox()
        self.modeBox.toolTip = sendmode.MODE_TIP
        for mode in sendmode.SEND_MODES:
            self.modeBox.addItem(mode.label, mode.key)
        self.modeBox.currentIndex = sendmode.mode_index(
            slicer.util.settingsValue(SEND_MODE_SETTING, sendmode.DEFAULT_SEND_MODE)
        )
        self.modeBox.connect("currentIndexChanged(int)", self.onModeChanged)
        self.toolbar.addWidget(self.modeBox)
        window.addToolBar(self.toolbar)

    def mode(self):
        """The chosen ``remoteview_core.sendmode.SendMode``."""
        from remoteview_core import sendmode  # noqa: PLC0415

        return sendmode.SEND_MODES[self.modeBox.currentIndex]

    def onModeChanged(self, _index: int = 0) -> None:
        """Saved at once; a panel with a controller follows (its live session too). A Qt slot: failures are logged by
        type only (T7), and one does not stop the other."""
        try:
            qt.QSettings().setValue(SEND_MODE_SETTING, self.mode().key)
        except Exception as exc:  # noqa: BLE001
            _log.error("RemoteView: send mode not saved (%s)", type(exc).__name__)
        try:
            widget = self.widget
            if widget is not None and widget.controller is not None:
                widget.controller.set_send_policy(self.mode().policy)
                widget.render(widget.controller.view)
        except Exception as exc:  # noqa: BLE001
            _log.error("RemoteView: send mode not applied (%s)", type(exc).__name__)

    def onSendNow(self) -> None:
        """With a running session, send; otherwise open the panel (Start session is there)."""
        try:
            widget = self.widget
            if widget is not None and widget.controller is not None and widget.controller.active:
                widget.render(widget.controller.send_now())
            else:
                slicer.util.selectModule("RemoteView")
        except Exception as exc:  # noqa: BLE001 — a Qt slot (T7)
            _log.error("RemoteView: scene not sent (%s)", type(exc).__name__)

    def show(self, view) -> None:
        """Follow a ``PanelView``: the button is enabled while a session runs and counts down while changes wait."""
        from remoteview_core import sendmode  # noqa: PLC0415

        self.sendAction.enabled = bool(view.code)
        self.sendAction.text = sendmode.send_button_text(
            code=view.code, changes_wait=view.changes_wait, due_in=view.due_in
        )


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
        self.flushTimer = None
        self.link = ""  # the join link of the running session (it holds the code): never logged
        self.qrLink = ""  # the link the cached pixmaps belong to
        self.qrPixmaps = {}  # pixel size -> QPixmap (or None when it could not be drawn)
        self.shownPixmaps = {}  # label name -> the pixmap it shows (assigned only when it changes)
        self.presentation = None
        self.presentationUi = None
        self.toolbar = None  # the SendToolbar (SLC-57), while the main window has one
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
        # toBool, settingsValue: https://github.com/Slicer/Slicer/blob/v5.12.4/Base/Python/slicer/util.py#L3634-L3670
        self.ui.removeIslandsCheckBox.checked = slicer.util.settingsValue(
            REMOVE_ISLANDS_SETTING, True, converter=slicer.util.toBool
        )
        self.ui.removeIslandsCheckBox.connect("toggled(bool)", self.onRemoveIslandsToggled)
        self.ui.startButton.connect("clicked(bool)", self.onStartClicked)
        self.ui.stopButton.connect("clicked(bool)", self.onStopClicked)
        self.ui.copyLinkButton.connect("clicked(bool)", self.onCopyLinkClicked)
        self.ui.presentButton.connect("clicked(bool)", self.onPresentClicked)

        self.pumpTimer = qt.QTimer()
        self.pumpTimer.setInterval(PUMP_INTERVAL_MS)
        self.pumpTimer.connect("timeout()", self.onPump)
        # the debouncer's single-shot timer (SLC-34): one for every session of this panel; a timeout posted after
        # Stop reaches a controller with no live session, which does nothing
        self.flushTimer = qt.QTimer()
        self.flushTimer.setSingleShot(True)
        self.flushTimer.connect("timeout()", self.onFlushTimer)
        try:  # the toolbar follows this panel from now (SLC-57); without one the panel works alone
            self.toolbar = sendToolbar()
            if self.toolbar is not None:
                self.toolbar.widget = self
        except Exception as exc:  # noqa: BLE001 — T7: type only
            _log.error("RemoteView: toolbar not attached (%s)", type(exc).__name__)

    def sendPolicy(self):
        """The send mode saved in the settings (SLC-57), as the controller takes it."""
        from remoteview_core import sendmode  # noqa: PLC0415 — standard library and the debouncer only

        return sendmode.send_mode(
            slicer.util.settingsValue(SEND_MODE_SETTING, sendmode.DEFAULT_SEND_MODE)
        ).policy

    def cleanup(self) -> None:
        """Called when the module is unloaded (Reload, exit): a running session is closed (waits up to 3 s), its
        observers removed, and both timers stopped and disconnected. Entered from C++: a failure to close the session
        is logged by type only, so Reload can finish (``slicer.util.reloadScriptedModule``); a failure clearing the
        widgets still propagates, after the session is closed and the timers disconnected."""
        for timer in (self.pumpTimer, self.flushTimer):
            if timer is not None:
                timer.stop()
        try:
            # no code is left on a projector or in a hidden label
            self.closePresentation()
            self.showPixmap("qrLabel", self.ui.qrLabel, None)
            self.forgetQr()
            self.link = ""
        finally:  # and the session is closed even if clearing the widgets failed
            try:
                if self.controller is not None:
                    self.controller.shutdown()  # session.close, observers removed, live updates stopped
            except Exception as exc:  # noqa: BLE001 — its text may carry a node ID (T7)
                _log.error("RemoteView: session not closed (%s)", type(exc).__name__)
            finally:
                self.controller = None
                self.logic = None
                if self.toolbar is not None and self.toolbar.widget is self:
                    self.toolbar.widget = None  # the toolbar outlives the panel (Reload)
                    self.toolbar = None
                if self.flushTimer is not None:
                    self.flushTimer.disconnect("timeout()", self.onFlushTimer)
                if self.pumpTimer is not None:
                    self.pumpTimer.disconnect("timeout()", self.onPump)

    def onRelayUrlChanged(self, url: str) -> None:
        from remoteview_core.consent import consent_text  # noqa: PLC0415 — standard library only

        self.ui.consentLabel.text = consent_text(url)

    def onRemoveIslandsToggled(self, checked: bool) -> None:
        """*Remove small islands* (SLC-54): saved at once; a live session sends the scene again, otherwise the next
        session uses it. A Qt slot: a failure is logged by its type only (T7), and one of the two does not stop the
        other."""
        try:
            qt.QSettings().setValue(REMOVE_ISLANDS_SETTING, bool(checked))
        except Exception as exc:  # noqa: BLE001 — a Qt slot (T7)
            _log.error("RemoteView: Remove small islands not saved (%s)", type(exc).__name__)
        try:
            if self.controller is not None:
                self.controller.set_remove_islands(bool(checked))
        except Exception as exc:  # noqa: BLE001 — a Qt slot (T7)
            _log.error("RemoteView: Remove small islands not applied (%s)", type(exc).__name__)

    def onStartClicked(self, _checked: bool = False) -> None:
        # Imported only now: nothing of the session machinery is loaded before the user starts (FR-02).
        from remoteview_core.panel import PanelController  # noqa: PLC0415

        if self.controller is None:
            self.controller = PanelController(
                slicer_version=slicer.app.applicationVersion,
                platform=sys.platform,
                scene=self.logic.sceneApi,
                ensure_deps=self.ensureDependencies,
                flush_timer=self.flushTimer,
                watch=self.makeWatcher,
                remove_islands=bool(self.ui.removeIslandsCheckBox.checked),
                send_policy=self.sendPolicy(),
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

    def makeWatcher(self, sink):
        """The scene observers of one live session (SLC-31), marking changes on ``sink`` (its ``LiveUpdates``)."""
        # imported at the first live session only (FR-02)
        from remoteview_core.observers import MrmlEvents, SceneWatcher  # noqa: PLC0415

        events = MrmlEvents(
            node_added=slicer.vtkMRMLScene.NodeAddedEvent,
            node_removed=slicer.vtkMRMLScene.NodeRemovedEvent,
            start_batch=slicer.vtkMRMLScene.StartBatchProcessEvent,
            end_batch=slicer.vtkMRMLScene.EndBatchProcessEvent,
            end_close=slicer.vtkMRMLScene.EndCloseEvent,
            display_modified=slicer.vtkMRMLDisplayableNode.DisplayModifiedEvent,
            mesh_modified=slicer.vtkMRMLModelNode.MeshModifiedEvent,
            transform_modified=slicer.vtkMRMLTransformableNode.TransformModifiedEvent,
            # vtkSegmentation's events, forwarded by every segmentation node (SLC-36; [TODO verify] the attributes
            # exist and read 62102 62103 62104 62101 62105 — manual §13 step 1, SLC-37)
            segment_added=slicer.vtkSegmentation.SegmentAdded,
            segment_removed=slicer.vtkSegmentation.SegmentRemoved,
            segment_modified=slicer.vtkSegmentation.SegmentModified,
            representation_modified=slicer.vtkSegmentation.RepresentationModified,
            representation_names_modified=slicer.vtkSegmentation.ContainedRepresentationNamesModified,
        )
        return SceneWatcher(
            sink,
            scene=slicer.mrmlScene,
            events=events,
            nodes_by_class=slicer.util.getNodesByClass,
            world_matrix=self.logic.sceneApi().world_matrix,
        )

    def onFlushTimer(self) -> None:
        """The scene changes marked since the last flush go out; the pump shows the result."""
        try:
            if self.controller is not None:
                self.controller.flush_live()
        except Exception as exc:  # noqa: BLE001 — a Qt slot: PyErr_Print would print the text (T7)
            _log.error("RemoteView: scene changes not sent (%s)", type(exc).__name__)

    def onPump(self) -> None:
        try:
            if self.controller is None:
                self.pumpTimer.stop()
            else:
                self.render(self.controller.pump())
                if not self.controller.active:
                    self.pumpTimer.stop()
        except Exception as exc:  # noqa: BLE001 — a Qt slot: PyErr_Print would print the text (T7)
            _log.error("RemoteView: panel not updated (%s)", type(exc).__name__)
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
        # the QR code next: Start/Stop and the texts are in place whatever drawing it does
        drawn = self.showLink(view.link, view.code)
        if view.link and not drawn:
            self.ui.detailLabel.text = "\n".join(
                part for part in (view.detail, QR_NOT_DRAWN) if part
            )
        if self.toolbar is not None:
            self.toolbar.show(view)

    def showLink(self, link: str, code: str) -> bool:
        """The QR code, *Copy link* and the Presentation window follow the session: only while it runs (T6). The
        window shows the code even without a QR code (a link too long for one, or one that cannot be drawn) — then
        reading the code out is the way in. Returns whether the panel shows a QR code."""
        self.link = link
        self.ui.copyLinkButton.enabled = bool(link)
        self.ui.presentButton.enabled = bool(code)
        if not link:
            self.forgetQr()  # the session's QR bitmaps hold its code
        qr = self.qrPixmap(link, MIN_QR_PIXELS) if link else None
        self.showPixmap("qrLabel", self.ui.qrLabel, qr)
        if not code:
            self.closePresentation()
        elif self.presentation is not None:
            ui = self.presentationUi
            ui.presentationCodeLabel.text = code
            big = self.qrPixmap(link, PRESENTATION_QR_PIXELS) if link else None
            self.showPixmap("presentationQrLabel", ui.presentationQrLabel, big)
            ui.presentationHintLabel.text = SCAN_HINT if big is not None else TYPE_HINT
        return qr is not None

    def showPixmap(self, name: str, label, pixmap) -> None:
        """Show ``pixmap`` on ``label`` (hide and empty it for ``None``). The label never gets smaller than the code:
        a layout that cropped the quiet zone would make it unscannable. Assigned only when it changes (every 50 ms
        otherwise)."""
        if name in self.shownPixmaps and self.shownPixmaps[name] is pixmap:
            return
        self.shownPixmaps[name] = pixmap
        if pixmap is None:
            label.visible = False
            label.clear()
            return
        label.setMinimumSize(pixmap.width(), pixmap.height())
        label.pixmap = pixmap
        label.visible = True

    def forgetQr(self) -> None:
        self.qrLink, self.qrPixmaps = "", {}

    def qrPixmap(self, link: str, minPixels: int):
        """The QR code of ``link`` as a ``QPixmap`` of at least ``minPixels``, painted dark on white whatever the Slicer
        theme (a light-on-dark code does not scan). Cached: the panel renders every 50 ms. ``None`` if it cannot be
        drawn — the link and the code stay usable; only the exception type is logged."""
        if link != self.qrLink:
            self.qrLink, self.qrPixmaps = link, {}
        if minPixels in self.qrPixmaps:
            return self.qrPixmaps[minPixels]
        from remoteview_core import links  # noqa: PLC0415 — imports segno, installed after consent (SLC-10)

        pixmap = None
        try:
            modules = links.qr_modules(link)
            scale = links.qr_scale(len(modules), minPixels)
            side = len(modules) * scale
            pixmap = qt.QPixmap(side, side)
            pixmap.fill(qt.QColor("white"))
            painter = qt.QPainter(pixmap)
            try:
                dark = qt.QColor("black")
                for x, y, width in links.dark_runs(modules):
                    painter.fillRect(x * scale, y * scale, width * scale, scale, dark)
            finally:
                painter.end()  # Qt must not destroy a device that is still being painted on
        except Exception as exc:  # noqa: BLE001 — a drawing problem must not end the session
            _log.warning("QR code not drawn (%s)", type(exc).__name__)
            pixmap = None
        self.qrPixmaps[minPixels] = pixmap
        return pixmap

    def onCopyLinkClicked(self, _checked: bool = False) -> None:
        if not self.link:
            return
        qt.QApplication.clipboard().setText(self.link)
        self.ui.copyLinkButton.text = "Link copied"
        qt.QTimer.singleShot(COPIED_FEEDBACK_MS, self.resetCopyLinkText)

    def resetCopyLinkText(self) -> None:
        if self.ui is not None:
            self.ui.copyLinkButton.text = "Copy link"

    def onPresentClicked(self, _checked: bool = False) -> None:
        code = self.controller.view.code if self.controller is not None else ""
        if not code:
            return
        if self.presentation is None:
            self.presentation = slicer.util.loadUI(self.resourcePath("UI/PresentationWindow.ui"))
            self.presentationUi = slicer.util.childWidgetVariables(self.presentation)
            font = self.presentationUi.presentationCodeLabel.font
            font.setStyleHint(qt.QFont.Monospace)
            font.setPointSize(PRESENTATION_CODE_POINTS)
            font.setLetterSpacing(qt.QFont.PercentageSpacing, 130)
            self.presentationUi.presentationCodeLabel.font = font
        self.showLink(self.link, code)
        self.presentation.show()
        self.presentation.raise_()

    def closePresentation(self) -> None:
        if self.presentation is not None:
            self.presentation.hide()
            self.presentationUi.presentationCodeLabel.text = ""
            self.showPixmap("presentationQrLabel", self.presentationUi.presentationQrLabel, None)


#
# RemoteViewLogic
#


class RemoteViewLogic(ScriptedLoadableModuleLogic):
    """Scene-side logic: the session lives in the panel's controller (SLC-09), which sends the scene this logic
    exposes as the session's first snapshot and then follows its changes (SLC-32 to SLC-34)."""

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
        """The current scene as ``remoteview_core.collect`` reads it: the model nodes (SLC-22) and the segments (SLC-35)
        the 3D view shows. No segmentations logic is injected: the adapter reads the representation the 3D view draws
        and never creates one (spec D-g; manual §13)."""
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
