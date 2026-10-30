"""The toolbar's choice of when changes go out (SLC-57): the modes it offers and the texts it shows.

Pure: the setting's value (a key) maps to a :class:`~remoteview_core.debounce.SendPolicy` here, an unknown value to
:data:`DEFAULT_SEND_MODE`; the *Send now* button's text follows the panel view (its countdown). Standard library and
``remoteview_core.debounce`` only, so the adapter can build the toolbar at Slicer's start (FR-02: nothing of the session
machinery is loaded by it).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from remoteview_core.debounce import AT_ONCE, SendPolicy

SEND_NOW = "Send scene now"
SEND_NOW_HELD = "Send now (changes wait)"  # for the button (manual), or for a batch to end
SEND_NOW_TIP = (
    "Send the changes waiting in Slicer to the viewers now, or the whole scene again when nothing waits. "
    "Needs a running session."
)
MODE_LABEL = "Send changes:"
MODE_TIP = (
    "When changes to the models and segments shown in 3D go to the viewers: at once, a number of seconds after "
    "the last change (the countdown is on the button), or only when you click Send scene now. A closed scene "
    "always leaves the viewers at once."
)


@dataclass(frozen=True)
class SendMode:
    key: str  # the value saved in the setting
    label: str  # the combo box entry
    policy: SendPolicy


SEND_MODES: tuple[SendMode, ...] = (
    SendMode("now", "At once", AT_ONCE),
    SendMode("15", "15 s after the last change", SendPolicy(delay_s=15.0)),
    SendMode("30", "30 s after the last change", SendPolicy(delay_s=30.0)),
    SendMode("60", "60 s after the last change", SendPolicy(delay_s=60.0)),
    SendMode("manual", "Only with Send scene now", SendPolicy(manual=True)),
)
#: The mode of a fresh installation (the owner's choice, 2026-10-30).
DEFAULT_SEND_MODE = "30"


def send_mode(key: object) -> SendMode:
    """The mode saved as ``key`` (a setting's value: anything), the default for an unknown one."""
    wanted = key.strip() if isinstance(key, str) else None
    for mode in SEND_MODES:
        if mode.key == wanted:
            return mode
    return send_mode(DEFAULT_SEND_MODE)


def mode_index(key: object) -> int:
    """The combo box index of :func:`send_mode` of ``key``."""
    return SEND_MODES.index(send_mode(key))


def send_button_text(
    *, code: str, changes_wait: bool, due_in: float | None, lanes: bool = False
) -> str:
    """The *Send scene now* button for a panel view: the countdown while changes wait under a delay, a note while
    they wait for the button or for a batch to end, the plain text otherwise — under the lanes (``lanes``, *At once*)
    too, whose own short waits are no countdown — and without a session, when the button is disabled."""
    if not code or not changes_wait or lanes:
        return SEND_NOW
    if due_in is None:
        return SEND_NOW_HELD
    return f"Send now ({max(1, math.ceil(due_in))} s)"
