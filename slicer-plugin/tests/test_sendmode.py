"""SLC-57: the send modes and the toolbar — *Send scene now* with its countdown, and the mode saved in the settings."""

from __future__ import annotations

import sys
from unittest import mock

import pytest
from conftest import StubMainWindow

from remoteview_core import sendmode
from remoteview_core.debounce import AT_ONCE, SendPolicy
from remoteview_core.panel import PanelView
from remoteview_core.sendmode import (
    DEFAULT_SEND_MODE,
    SEND_MODES,
    SEND_NOW,
    SEND_NOW_HELD,
    mode_index,
    send_button_text,
    send_mode,
)

SETTING = "RemoteView/SendMode"

# --------------------------------------------------------------------------- the modes


def test_sendmode_offers_at_once_three_delays_and_manual():
    assert [m.key for m in SEND_MODES] == ["now", "15", "30", "60", "manual"]
    assert [m.policy for m in SEND_MODES] == [
        AT_ONCE,
        SendPolicy(delay_s=15.0),
        SendPolicy(delay_s=30.0),
        SendPolicy(delay_s=60.0),
        SendPolicy(manual=True),
    ]
    assert len({m.label for m in SEND_MODES}) == len(SEND_MODES)
    assert send_mode(DEFAULT_SEND_MODE).policy == SendPolicy(delay_s=30.0)


@pytest.mark.parametrize("value", [None, "", "x", 15, "9", " manual "])
def test_sendmode_an_unknown_setting_is_the_default_and_a_known_one_is_kept(value):
    expected = "manual" if value == " manual " else DEFAULT_SEND_MODE
    assert send_mode(value).key == expected and mode_index(value) == mode_index(expected)


def test_sendmode_button_text_counts_down_while_changes_wait():
    assert send_button_text(code="", changes_wait=True, due_in=5.0) == SEND_NOW  # no session
    assert send_button_text(code="ABCDE", changes_wait=False, due_in=None) == SEND_NOW
    assert send_button_text(code="ABCDE", changes_wait=True, due_in=None) == SEND_NOW_HELD
    assert send_button_text(code="ABCDE", changes_wait=True, due_in=12.3) == "Send now (13 s)"
    assert send_button_text(code="ABCDE", changes_wait=True, due_in=0.0) == "Send now (1 s)"
    # At once: the lanes' own 150-750 ms waits are no countdown (review of SLC-57)
    assert send_button_text(code="ABCDE", changes_wait=True, due_in=0.15, lanes=True) == SEND_NOW


# --------------------------------------------------------------------------- the toolbar


@pytest.fixture
def window(slicer_stubs):
    window = StubMainWindow()
    slicer_stubs["slicer.util"].mainWindow = lambda: window
    return window


def _module(import_remote_view):
    sys.modules.pop("RemoteView", None)  # a fresh module object each time, like Slicer's Reload
    module = import_remote_view()
    module.RemoteView(
        mock.MagicMock(name="qSlicerScriptedLoadableModule")
    )  # startupCompleted fires at once
    return module


def test_sendmode_toolbar_is_made_at_startup_with_the_saved_mode(
    import_remote_view, slicer_stubs, window
):
    slicer_stubs["qt"].QSettings().setValue(SETTING, "manual")
    module = _module(import_remote_view)
    [toolbar] = window.toolbars
    assert toolbar.objectName == "RemoteViewToolBar" and toolbar.parent is window
    [action] = toolbar.actions
    assert (action.text, action.enabled) == (SEND_NOW, False) and action.toolTip
    label, box = toolbar.widgets
    assert label.text == sendmode.MODE_LABEL and box.toolTip == sendmode.MODE_TIP
    assert [data for _, data in box.items] == [m.key for m in SEND_MODES]
    assert box.currentIndex == mode_index("manual")
    assert module.sendToolbar() is module.sendToolbar() and module.sendToolbar().toolbar is toolbar


def test_sendmode_toolbar_defaults_without_a_setting_and_replaces_a_previous_one(
    import_remote_view, slicer_stubs, window
):
    first = _module(import_remote_view).sendToolbar().toolbar
    assert first.widgets[1].currentIndex == mode_index(DEFAULT_SEND_MODE)
    slicer_stubs["slicer.util"].mainWindow = lambda: None
    assert (
        _module(import_remote_view).sendToolbar() is None
    )  # a headless Slicer: no toolbar, no error
    slicer_stubs["slicer.util"].mainWindow = lambda: window
    second = _module(import_remote_view).sendToolbar().toolbar  # a Reload: a new module object
    assert window.toolbars == [second] and first.deleted and not second.deleted


def test_sendmode_toolbar_saves_the_mode_and_hands_it_to_the_panel(
    import_remote_view, slicer_stubs, window
):
    module = _module(import_remote_view)
    toolbar = module.sendToolbar()
    widget = module.RemoteViewWidget(mock.MagicMock(name="parentWidget"))
    widget.setup()
    assert widget.toolbar is toolbar and toolbar.widget is widget
    assert widget.sendPolicy() == SendPolicy(delay_s=30.0)
    toolbar.modeBox.currentIndex = mode_index("15")  # no controller yet: saved only
    assert slicer_stubs["qt"].QSettings().value(SETTING) == "15"
    assert widget.sendPolicy() == SendPolicy(delay_s=15.0)
    with mock.patch("remoteview_core.panel.PanelController") as controller_class:
        made = controller_class.return_value
        made.active = False
        made.start.return_value = made.view = PanelView("Cannot start the session.")
        widget.onStartClicked()
    assert controller_class.call_args.kwargs["send_policy"] == SendPolicy(delay_s=15.0)
    widget.controller = controller = mock.MagicMock(name="controller")
    controller.view = PanelView("Live · no viewers yet.", code="ABCDE")
    toolbar.modeBox.currentIndex = mode_index("manual")
    controller.set_send_policy.assert_called_once_with(SendPolicy(manual=True))
    controller.note_activity.assert_called_once_with()  # someone is at Slicer (SLC-47)
    assert widget.ui.statusLabel.text == "Live · no viewers yet."  # rendered after the change
    widget.cleanup()
    assert toolbar.widget is None and widget.toolbar is None


def test_sendmode_toolbar_sends_now_or_opens_the_panel(
    import_remote_view, slicer_stubs, window, caplog
):
    module = _module(import_remote_view)
    toolbar = module.sendToolbar()
    action = toolbar.sendAction
    action.slots["triggered()"]()  # the panel was never opened
    slicer_stubs["slicer.util"].selectModule.assert_called_once_with("RemoteView")
    widget = module.RemoteViewWidget(mock.MagicMock(name="parentWidget"))
    widget.setup()
    action.slots["triggered()"]()  # opened, no session
    assert slicer_stubs["slicer.util"].selectModule.call_count == 2
    widget.controller = controller = mock.MagicMock(name="controller")
    controller.active = True
    waiting = PanelView("Live · no viewers yet.", code="ABCDE", changes_wait=True, due_in=4.2)
    controller.send_now.return_value = controller.view = waiting
    widget.render(waiting)
    assert (action.enabled, action.text) == (True, "Send now (5 s)")
    action.slots["triggered()"]()
    controller.send_now.assert_called_once_with()
    controller.note_activity.assert_called_once_with()  # someone is at Slicer (SLC-47)
    widget.render(PanelView("Live · no viewers yet.", code="ABCDE", changes_wait=True))
    assert action.text == SEND_NOW_HELD
    toolbar.modeBox.currentIndex = mode_index("now")
    widget.render(waiting)
    assert action.text == SEND_NOW  # At once: no countdown
    toolbar.modeBox.currentIndex = mode_index("manual")
    widget.render(PanelView("Not connected."))
    assert (action.enabled, action.text) == (False, SEND_NOW)
    controller.send_now.side_effect = KeyError("vtkMRMLModelNode4 Doe^John")
    with caplog.at_level("DEBUG"):
        action.slots["triggered()"]()
    assert "RemoteView: scene not sent (KeyError)" in caplog.text and "Doe" not in caplog.text


def test_sendmode_toolbar_failures_leave_the_panel_working(
    import_remote_view, slicer_stubs, monkeypatch, caplog
):
    """A toolbar that cannot be made (a PythonQt call that fails, §16) costs nothing: the panel opens, Start works."""

    class Broken:
        def findChildren(self, _class_name):  # noqa: N802 — Qt's name
            raise TypeError("vtkMRMLModelNode4 Doe^John")

    slicer_stubs["slicer.util"].mainWindow = Broken
    with caplog.at_level("DEBUG"):
        module = _module(import_remote_view)
        widget = module.RemoteViewWidget(mock.MagicMock(name="parentWidget"))
        widget.setup()
    assert widget.toolbar is None and widget.sendPolicy() == SendPolicy(delay_s=30.0)
    assert caplog.text.count("(TypeError)") == 2 and "Doe" not in caplog.text
    widget.render(PanelView("Not connected."))  # no toolbar to follow
