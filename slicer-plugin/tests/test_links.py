"""SLC-11: the join link, its QR code, and how the panel and the Qt adapter show them."""

from __future__ import annotations

import logging
import re
import sys
import xml.etree.ElementTree as ET
from dataclasses import replace
from urllib.parse import urlsplit

import numpy as np
import pytest
import zxingcpp
from conftest import MODULE_DIR, ui_widget_names
from support import CODE, URL, FakeTransport, created, deliver, parent_widget, viewer_count

from remoteview_core import deps, links, panel
from remoteview_core.panel import PanelController
from remoteview_core.transport import Connected, Disconnected, Received

PRESENTATION_UI = MODULE_DIR / "Resources" / "UI" / "PresentationWindow.ui"
LINK = f"https://relay.example.org/j#{CODE}"


def image_of(modules: list[list[bool]], scale: int) -> np.ndarray:
    """What a camera sees: dark modules black on white, each ``scale`` pixels wide."""
    grid = np.array([[0 if dark else 255 for dark in row] for row in modules], dtype=np.uint8)
    return np.kron(grid, np.ones((scale, scale), dtype=np.uint8))


def pixmap_image(pixmap) -> np.ndarray:
    """The stub ``QPixmap`` as a camera sees it: white, with the painted rectangles black."""
    assert pixmap.fills == ["white"]
    width, height = pixmap.size
    image = np.full((height, width), 255, dtype=np.uint8)
    for x, y, rect_width, rect_height, color in pixmap.rects:
        assert color == "black"
        image[y : y + rect_height, x : x + rect_width] = 0
    return image


# --------------------------------------------------------------------------- join_url


@pytest.mark.parametrize(
    ("relay", "link"),
    [
        ("wss://relay.example/ws", "https://relay.example/j#7KQ4X"),  # the plan's example
        ("wss://relay.example:8443/ws", "https://relay.example:8443/j#7KQ4X"),
        (
            "wss://relay.example:443/ws",
            "https://relay.example/j#7KQ4X",
        ),  # the default port is dropped
        ("ws://127.0.0.1:8787/ws", "http://127.0.0.1:8787/j#7KQ4X"),  # loopback only, no TLS
        ("ws://localhost/ws", "http://localhost/j#7KQ4X"),
        ("ws://localhost:80/ws", "http://localhost/j#7KQ4X"),
        (
            "wss://relay.example:80/ws",
            "https://relay.example:80/j#7KQ4X",
        ),  # 80 is not https's default
        ("ws://localhost:443/ws", "http://localhost:443/j#7KQ4X"),  # nor is 443 http's
        ("ws://[::1]:8787/ws", "http://[::1]:8787/j#7KQ4X"),
        ("wss://[2001:db8::1]/ws", "https://[2001:db8::1]/j#7KQ4X"),
    ],
)
def test_links_join_url(relay, link):
    assert links.join_url(relay, "7KQ4X") == link


def test_links_the_code_is_the_fragment_and_only_the_fragment():
    for relay in ("wss://relay.example/ws", "ws://127.0.0.1:8787/ws"):
        parts = urlsplit(links.join_url(relay, CODE))
        # T6, NFR-15: a fragment never reaches a server, a proxy or a log
        assert (parts.path, parts.query, parts.fragment, parts.username) == ("/j", "", CODE, None)
        assert links.join_url(relay, CODE).count("#") == 1 and "?" not in links.join_url(
            relay, CODE
        )


@pytest.mark.parametrize(
    "relay",
    [
        "wss://user:hunter2@relay.example/ws",
        "wss://relay.example/ws?token=hunter2",
        "wss://relay.example/ws#hunter2",
        "ws://relay.example/ws",  # plain ws:// only to the loopback (§3.1)
        "wss://relay.example/anything/else",  # not at /ws: where its viewer is, is unknown
        "wss://relay.example/hunter2",  # the transport allows a path: the /ws refusal must not echo it
        "wss://relay.example/",
        "https://relay.example/ws",
        "wss://",
        "",
    ],
)
def test_links_join_url_refuses_a_relay_the_transport_would_refuse_and_echoes_nothing(relay):
    with pytest.raises(ValueError, match=r"^[^@]*$") as raised:
        links.join_url(relay, CODE)
    assert "hunter2" not in str(raised.value)


@pytest.mark.parametrize(
    "code",
    [
        "",
        "7KQ4",
        "7KQ4XX",
        "7kq4x",
        "7KQ0X",
        "7KQOX",
        "7KQ1X",
        "7KQIX",
        "7KQLX",
        " 7KQ4X",
        "7KQ4X\n",
        "7KQ-X",
        "7KQ4é",
    ],
)
def test_links_join_url_refuses_anything_that_is_not_a_session_code(code):
    with pytest.raises(ValueError, match="not a session code") as raised:
        links.join_url("wss://relay.example/ws", code)
    assert code.strip() not in str(raised.value) or not code.strip()


def test_links_join_url_is_at_most_64_characters():
    # "https://" + host + "/j#7KQ4X" is 16 characters longer than the host
    ok = "a" * 48
    assert len(links.join_url(f"wss://{ok}/ws", CODE)) == 64
    with pytest.raises(ValueError, match="longer than 64"):
        links.join_url(f"wss://{'a' * 49}/ws", CODE)
    # a port counts too
    with pytest.raises(ValueError, match="longer than 64"):
        links.join_url(f"wss://{'a' * 44}:8443/ws", CODE)
    assert len(links.join_url(f"wss://{'a' * 43}:8443/ws", CODE)) == 64


# --------------------------------------------------------------------------- the QR code


@pytest.mark.parametrize(
    "relay",
    [
        "wss://relay.example/ws",
        "wss://slicerremoteview-production.up.railway.app/ws",
        "wss://" + "a" * 48 + "/ws",
        "ws://127.0.0.1:8787/ws",
    ],
)
def test_links_the_qr_code_scans_back_to_the_link(relay):
    link = links.join_url(relay, CODE)
    modules = links.qr_modules(link)
    scale = links.qr_scale(len(modules))
    [result] = zxingcpp.read_barcodes(image_of(modules, scale))
    # what a phone camera returns: the exact link, from a QR code (not a Micro QR) at error level M
    assert (result.text, result.format, result.ec_level) == (
        link,
        zxingcpp.BarcodeFormat.QRCode,
        "M",
    )
    assert result.valid and not result.error


def test_links_the_qr_code_has_a_quiet_zone_and_is_not_symmetric():
    modules = links.qr_modules(LINK)
    side = len(modules)
    assert all(len(row) == side for row in modules) and side >= 21 + 2 * links.QUIET_ZONE_MODULES
    assert links.QUIET_ZONE_MODULES >= 2  # NFR-30
    border = links.QUIET_ZONE_MODULES
    assert not any(any(row) for row in modules[:border]) and not any(
        any(row) for row in modules[-border:]
    )
    assert not any(any(row[:border]) or any(row[-border:]) for row in modules)
    # a code that equals its transpose would hide an x/y mix-up in the adapter
    assert [list(column) for column in zip(*modules, strict=True)] != modules
    # without the border the three finder patterns are there: dark corners of the symbol
    inner = [row[border:-border] for row in modules[border:-border]]
    for top, left in ((0, 0), (0, len(inner) - 7), (len(inner) - 7, 0)):
        ring = [inner[top][left + i] for i in range(7)] + [
            inner[top + 6][left + i] for i in range(7)
        ]
        ring += [inner[top + i][left] for i in range(7)] + [
            inner[top + i][left + 6] for i in range(7)
        ]
        assert all(ring)  # the dark outer ring of each 7×7 finder pattern


def test_links_the_modules_are_the_library_matrix_in_its_orientation():
    import segno  # noqa: PLC0415 — the dev environment has the pinned release

    border = links.QUIET_ZONE_MODULES
    expected = [
        [bool(m) for m in row]
        for row in segno.make(LINK, error="m", micro=False, boost_error=False).matrix
    ]
    inner = [row[border:-border] for row in links.qr_modules(LINK)[border:-border]]
    assert inner == expected  # not transposed, not mirrored: x is the column, y the row


def test_links_a_custom_border_is_honoured():
    plain = links.qr_modules(LINK, border=0)
    wide = links.qr_modules(LINK, border=6)
    assert len(wide) == len(plain) + 12 and [row[6:-6] for row in wide[6:-6]] == plain


def test_links_the_scale_gives_at_least_240_pixels_and_no_more_than_needed():
    for relay in ("wss://relay.example/ws", "wss://" + "a" * 48 + "/ws"):
        side = len(links.qr_modules(links.join_url(relay, CODE)))
        scale = links.qr_scale(side)
        assert scale * side >= links.MIN_QR_PIXELS == 240
        assert (
            scale - 1
        ) * side < links.MIN_QR_PIXELS  # the smallest whole-pixel scale that is big enough
        assert links.qr_scale(side, 480) * side >= 480
    assert links.qr_scale(500) == 1  # never zero


def test_links_dark_runs_paint_exactly_the_dark_modules():
    modules = links.qr_modules(LINK)
    runs = links.dark_runs(modules)
    painted = np.zeros((len(modules), len(modules)), dtype=bool)
    for x, y, width in runs:
        assert width >= 1 and not painted[y, x : x + width].any()  # runs never overlap
        painted[y, x : x + width] = True
    assert painted.tolist() == modules
    assert len(runs) < 0.6 * sum(map(sum, modules))  # fewer rectangles than modules
    assert links.dark_runs([[False, False]]) == [] and links.dark_runs(
        [[True, True, False, True]]
    ) == [
        (0, 0, 2),
        (3, 0, 1),
    ]


def test_links_without_segno_the_qr_code_cannot_be_drawn(monkeypatch):
    monkeypatch.setitem(sys.modules, "segno", None)  # an import of segno now raises ImportError
    with pytest.raises(ImportError):
        links.qr_modules(LINK)


def test_links_nothing_is_logged_for_a_link(caplog):
    with caplog.at_level(logging.DEBUG):
        links.qr_modules(links.join_url("wss://relay.example/ws", CODE))
    assert caplog.text == ""


# --------------------------------------------------------------------------- the controller


def live(url: str = URL):
    ctl = PanelController(
        slicer_version="5.12.4", platform="win32", transport_factory=FakeTransport
    )
    ctl.start(url)
    return ctl, deliver(ctl, Connected(1), Received(1, created()))


def test_panel_the_live_view_carries_the_join_link_on_the_relays_host(fake):
    ctl, view = live()
    assert view.link == LINK and view.code == CODE
    assert LINK not in repr(view) and CODE not in repr(view)  # logs and tracebacks
    _, local = live("ws://127.0.0.1:8787/ws")
    assert local.link == f"http://127.0.0.1:8787/j#{CODE}"
    assert ctl.view.link == LINK


def test_panel_the_link_is_gone_when_the_session_is_not_live(fake):
    ctl = PanelController(
        slicer_version="5.12.4", platform="win32", transport_factory=FakeTransport
    )
    assert ctl.start(URL).link == ""  # connecting
    assert deliver(ctl, Connected(1)).link == ""  # waiting for session.created
    assert deliver(ctl, Received(1, created())).link == LINK
    stopping = ctl.stop()
    assert stopping.link == "" and stopping.code == ""
    ended = deliver(ctl, Disconnected(1, None, None, final_sent=True))
    assert ended.link == "" and ended.start_enabled


def test_panel_a_link_that_is_too_long_for_a_qr_code_says_so_and_keeps_the_code(fake):
    long_host = "a" * 49
    _, view = live(f"wss://{long_host}/ws")
    assert view.link == "" and view.code == CODE and view.detail == panel.NO_LINK
    assert long_host not in view.detail


def test_panel_a_relay_that_is_not_at_ws_gets_no_link(fake):
    _, view = live("wss://relay.example.org/relay/ws")
    assert view.link == "" and view.code == CODE and view.detail == panel.NO_LINK


def test_panel_the_too_long_note_follows_the_other_notes(fake):
    ctl = PanelController(
        slicer_version="5.12.4", platform="win32", transport_factory=FakeTransport
    )
    ctl.start(f"wss://{'a' * 49}/ws", extra_ca_file="/etc/hospital-root.pem")
    view = deliver(ctl, Connected(1), Received(1, created()))
    assert view.detail == f"{panel.EXTRA_CA_IN_USE}\n{panel.NO_LINK}"


# --------------------------------------------------------------------------- the Qt adapter (against the stubs)


@pytest.fixture
def widget(import_remote_view, monkeypatch, fake, packages_installed):
    module = import_remote_view()
    monkeypatch.setattr(panel, "RelayTransport", FakeTransport)
    instance = module.RemoteViewWidget(parent=parent_widget())
    instance.setup()
    instance.ui.relayUrlLineEdit.text = URL
    instance.ui.extraCaPathLineEdit.currentPath = ""
    return module, instance


def go_live(instance, fake, code: str = CODE) -> FakeTransport:
    instance.onStartClicked()
    transport = fake.made[-1]
    transport.events.put(Connected(1))
    transport.events.put(Received(1, created(code=code)))
    instance.onPump()
    return transport


def end(instance, transport) -> None:
    instance.onStopClicked()
    transport.events.put(Disconnected(1, None, None, final_sent=True))
    instance.onPump()


def test_adapter_before_a_session_there_is_no_qr_code_and_the_buttons_are_off(widget):
    _, instance = widget
    ui = instance.ui
    instance.render(panel.PanelView(panel.NOT_CONNECTED))
    assert ui.qrLabel.visible is False and ui.copyLinkButton.enabled is False
    assert ui.presentButton.enabled is False


def test_adapter_the_panel_shows_a_qr_code_that_scans_to_the_link(widget, fake):
    _, instance = widget
    go_live(instance, fake)
    ui = instance.ui
    assert ui.qrLabel.visible is True and ui.copyLinkButton.enabled and ui.presentButton.enabled
    pixmap = ui.qrLabel.pixmap
    width, height = pixmap.size
    assert width == height >= 240  # NFR-30
    [result] = zxingcpp.read_barcodes(pixmap_image(pixmap))
    assert result.text == LINK and result.ec_level == "M"
    # Qt refuses a device that is still being painted on
    assert pixmap.painter is not None and pixmap.painter.ended
    # painted as a camera needs it: dark modules on a white field, whatever the Slicer theme
    modules = links.qr_modules(LINK)
    scale = width // len(modules)
    assert width == scale * len(modules) and pixmap.dark_modules(scale) == {
        (x, y) for y, row in enumerate(modules) for x, dark in enumerate(row) if dark
    }


def test_adapter_the_qr_code_is_drawn_once_per_link_not_every_tick(widget, fake, monkeypatch):
    module, instance = widget
    made = []
    original = module.qt.QPixmap
    monkeypatch.setattr(module.qt, "QPixmap", lambda w, h: made.append((w, h)) or original(w, h))
    transport = go_live(instance, fake)
    first = instance.ui.qrLabel.pixmap
    for _ in range(5):
        transport.events.put(
            Received(
                1,
                viewer_count(1),
            )
        )
        instance.onPump()
    assert len(made) == 1 and instance.ui.qrLabel.pixmap is first


def test_adapter_stopping_removes_the_qr_code_and_switches_the_buttons_off(widget, fake):
    _, instance = widget
    transport = go_live(instance, fake)
    instance.onStopClicked()
    ui = instance.ui
    assert (
        ui.qrLabel.visible is False
        and ui.copyLinkButton.enabled is False
        and ui.presentButton.enabled is False
    )
    assert instance.link == ""
    transport.events.put(Disconnected(1, None, None, final_sent=True))
    instance.onPump()
    assert instance.link == "" and ui.codeLabel.text == ""


def test_adapter_copy_link_puts_the_link_on_the_clipboard_and_says_so(
    widget, fake, monkeypatch, slicer_stubs
):
    module, instance = widget
    pending = []
    monkeypatch.setattr(
        module.qt.QTimer,
        "singleShot",
        staticmethod(lambda ms, callback: pending.append((ms, callback))),
    )
    clipboard = slicer_stubs["qt"].QApplication.clipboard()
    instance.onCopyLinkClicked()  # nothing to copy before the session is live
    assert clipboard.text == "" and pending == []
    go_live(instance, fake)
    instance.onCopyLinkClicked()
    assert clipboard.text == LINK and instance.ui.copyLinkButton.text == "Link copied"
    [(delay, reset)] = pending
    assert delay == module.COPIED_FEEDBACK_MS
    reset()
    assert instance.ui.copyLinkButton.text == "Copy link"


def test_adapter_the_presentation_window_shows_the_code_large_and_a_bigger_qr_code(
    widget, fake, slicer_stubs
):
    module, instance = widget
    loaded = []
    original = slicer_stubs["slicer.util"].loadUI
    slicer_stubs["slicer.util"].loadUI = lambda path: loaded.append(path) or original(path)
    instance.onPresentClicked()  # not before the session is live
    assert loaded == [] and instance.presentation is None
    go_live(instance, fake)
    instance.onPresentClicked()
    assert loaded == [str(MODULE_DIR / "Resources" / "UI" / "PresentationWindow.ui")]
    ui = instance.presentationUi
    assert ui.presentationCodeLabel.text == CODE
    # NFR-29: the code in at least 48 pt, monospace
    assert module.PRESENTATION_CODE_POINTS >= 48
    font = ui.presentationCodeLabel.font
    font.setPointSize.assert_called_once_with(module.PRESENTATION_CODE_POINTS)
    font.setStyleHint.assert_called_once()
    instance.presentation.show.assert_called_once()
    width, height = ui.presentationQrLabel.pixmap.size
    assert width == height >= module.PRESENTATION_QR_PIXELS > instance.ui.qrLabel.pixmap.size[0]
    [result] = zxingcpp.read_barcodes(pixmap_image(ui.presentationQrLabel.pixmap))
    assert result.text == LINK and ui.presentationHintLabel.text == module.SCAN_HINT
    # a second click shows the same window again
    instance.onPresentClicked()
    assert len(loaded) == 1 and instance.presentation.show.call_count == 2
    assert instance.presentation.raise_.call_count == 2  # a second click brings it to the front


def test_adapter_the_presentation_window_closes_with_the_session(widget, fake):
    _, instance = widget
    transport = go_live(instance, fake)
    instance.onPresentClicked()
    window, ui = instance.presentation, instance.presentationUi
    instance.onStopClicked()
    window.hide.assert_called()
    assert ui.presentationCodeLabel.text == ""  # no code left on a projector
    ui.presentationQrLabel.clear.assert_called()
    transport.events.put(Disconnected(1, None, None, final_sent=True))
    instance.onPump()
    # a later session reuses the window and shows the new code
    go_live(instance, fake)
    instance.onPresentClicked()
    assert instance.presentation is window and ui.presentationCodeLabel.text == CODE


def test_adapter_cleanup_closes_the_presentation_window_and_forgets_the_link(widget, fake):
    _, instance = widget
    go_live(instance, fake)
    instance.onPresentClicked()
    window = instance.presentation
    instance.cleanup()
    window.hide.assert_called()
    assert instance.ui.qrLabel.visible is False
    instance.ui.qrLabel.clear.assert_called()
    assert (
        instance.link == ""
        and instance.qrPixmaps == {}
        and instance.presentationUi.presentationCodeLabel.text == ""
    )


def test_adapter_a_qr_code_that_cannot_be_drawn_leaves_the_link_and_the_code_working(
    widget, fake, monkeypatch, caplog, slicer_stubs
):
    _, instance = widget
    monkeypatch.setitem(sys.modules, "segno", None)
    with caplog.at_level(logging.DEBUG):
        go_live(instance, fake)
    ui = instance.ui
    assert (
        ui.qrLabel.visible is False and ui.codeLabel.text == CODE
    )  # the code is still read out loud
    assert ui.copyLinkButton.enabled is True  # and the link can still be copied
    instance.onCopyLinkClicked()
    assert slicer_stubs["qt"].QApplication.clipboard().text == LINK
    assert "QR code not drawn (ModuleNotFoundError)" in caplog.text
    assert LINK not in caplog.text and CODE not in caplog.text


def test_adapter_the_qr_label_never_gets_smaller_than_the_code_and_is_set_once(widget, fake):
    _, instance = widget
    transport = go_live(instance, fake)
    pixmap = instance.ui.qrLabel.pixmap
    # a layout that squeezed the label would crop the quiet zone: the label keeps the pixmap's size
    instance.ui.qrLabel.setMinimumSize.assert_called_once_with(*pixmap.size)
    for _ in range(5):  # the panel renders every 50 ms; the pixmap is assigned once
        transport.events.put(Received(1, viewer_count(2)))
        instance.onPump()
    assert instance.ui.qrLabel.setMinimumSize.call_count == 1


def test_adapter_a_second_session_shows_its_own_code_and_qr_code(widget, fake):
    _, instance = widget
    transport = go_live(instance, fake)
    instance.onPresentClicked()
    end(instance, transport)
    # the session's QR bitmaps (they hold its code) are dropped with it
    assert instance.qrLink == "" and instance.qrPixmaps == {}
    instance.ui.qrLabel.clear.assert_called()
    go_live(instance, fake, code="ABCDE")
    instance.onPresentClicked()
    new_link = "https://relay.example.org/j#ABCDE"
    for pixmap in (instance.ui.qrLabel.pixmap, instance.presentationUi.presentationQrLabel.pixmap):
        [result] = zxingcpp.read_barcodes(pixmap_image(pixmap))
        assert result.text == new_link  # not the previous session's
    assert instance.presentationUi.presentationCodeLabel.text == "ABCDE"
    assert instance.ui.codeLabel.text == "ABCDE" and instance.link == new_link


def test_adapter_a_link_too_long_for_a_qr_code_still_offers_the_large_code(widget, fake):
    """The panel says to read the code out: the Presentation window (NFR-29) is how a room reads it."""
    module, instance = widget
    instance.ui.relayUrlLineEdit.text = f"wss://{'a' * 49}/ws"
    go_live(instance, fake)
    ui = instance.ui
    assert ui.detailLabel.text == panel.NO_LINK and ui.codeLabel.text == CODE
    assert ui.qrLabel.visible is False and ui.copyLinkButton.enabled is False
    assert ui.presentButton.enabled is True
    instance.onPresentClicked()
    window = instance.presentationUi
    assert window.presentationCodeLabel.text == CODE and window.presentationQrLabel.visible is False
    assert window.presentationHintLabel.text == module.TYPE_HINT


def test_adapter_a_qr_code_that_cannot_be_drawn_is_said_and_the_window_shows_the_code(
    widget, fake, monkeypatch
):
    module, instance = widget
    monkeypatch.setitem(sys.modules, "segno", None)
    go_live(instance, fake)
    assert instance.ui.detailLabel.text == module.QR_NOT_DRAWN  # not only a log line
    instance.onPresentClicked()
    window = instance.presentationUi
    assert window.presentationCodeLabel.text == CODE and window.presentationQrLabel.visible is False
    assert window.presentationHintLabel.text == module.TYPE_HINT  # no "scan" under an empty square


def test_adapter_a_link_that_changes_while_live_replaces_the_qr_code(widget):
    """A code that changes without an empty view in between (SLC-17's resume may do that) gets its own QR code."""
    _, instance = widget
    live_view = panel.PanelView("Session running", start_enabled=False, stop_enabled=True)
    first, second = "https://relay.example.org/j#7KQ4X", "https://relay.example.org/j#ABCDE"
    instance.render(replace(live_view, code="7KQ4X", link=first))
    instance.render(replace(live_view, code="ABCDE", link=second))
    [result] = zxingcpp.read_barcodes(pixmap_image(instance.ui.qrLabel.pixmap))
    assert result.text == second and instance.link == second


def test_adapter_each_size_is_drawn_once_with_the_presentation_window_open(
    widget, fake, monkeypatch
):
    module, instance = widget
    made = []
    original = module.qt.QPixmap
    monkeypatch.setattr(module.qt, "QPixmap", lambda w, h: made.append((w, h)) or original(w, h))
    transport = go_live(instance, fake)
    instance.onPresentClicked()
    small, big = instance.ui.qrLabel.pixmap, instance.presentationUi.presentationQrLabel.pixmap
    for _ in range(5):
        transport.events.put(Received(1, viewer_count(1)))
        instance.onPump()
    assert len(made) == 2 and made[0][0] < made[1][0]  # 240 px and 480 px, once each
    assert instance.ui.qrLabel.pixmap is small
    assert instance.presentationUi.presentationQrLabel.pixmap is big


def test_adapter_a_qr_code_that_cannot_be_drawn_is_logged_once(widget, fake, monkeypatch, caplog):
    _, instance = widget
    monkeypatch.setitem(sys.modules, "segno", None)
    with caplog.at_level(logging.DEBUG):
        transport = go_live(instance, fake)
        for _ in range(5):
            transport.events.put(Received(1, viewer_count(1)))
            instance.onPump()
    assert caplog.text.count("QR code not drawn") == 1  # the failure is cached like a pixmap


def test_adapter_cleanup_closes_the_session_even_if_a_widget_fails(widget, fake):
    _, instance = widget
    transport = go_live(instance, fake)
    instance.onPresentClicked()
    instance.presentation.hide.side_effect = RuntimeError("widget already deleted")
    with pytest.raises(RuntimeError, match="already deleted"):
        instance.cleanup()
    assert transport.stops  # session.close was still sent
    assert instance.controller is None


def test_adapter_the_qr_size_constant_is_the_core_one(widget):
    module, _ = widget
    assert module.MIN_QR_PIXELS == links.MIN_QR_PIXELS


def test_adapter_nothing_about_the_link_reaches_the_log(widget, fake, caplog):
    _, instance = widget
    with caplog.at_level(logging.DEBUG):
        go_live(instance, fake)
        instance.onCopyLinkClicked()
        instance.onPresentClicked()
        instance.onStopClicked()
    assert CODE not in caplog.text and "relay.example.org/j" not in caplog.text


# --------------------------------------------------------------------------- the .ui files


def test_presentation_ui_defines_every_widget_the_adapter_uses():
    names = ui_widget_names(PRESENTATION_UI)
    assert len(names) == len(set(names))
    adapter = (MODULE_DIR / "RemoteView.py").read_text()
    used = set(re.findall(r"\b(presentation[A-Z]\w*)", adapter)) - {"presentationUi"}
    assert {"presentationCodeLabel", "presentationQrLabel", "presentationHintLabel"} <= used
    assert used <= set(names), sorted(used - set(names))


def test_presentation_ui_properties():
    root = ET.parse(PRESENTATION_UI).getroot()  # noqa: S314 — the module's own file
    widgets = {w.get("name"): w for w in root.iter("widget")}

    def prop(widget: str, name: str):
        return widgets[widget].find(f"property[@name='{name}']")

    font = prop("presentationCodeLabel", "font").find("font")
    assert int(font.findtext("pointsize")) >= 48 and font.findtext("bold") == "true"  # NFR-29
    assert font.findtext("family") == "Courier New"
    size = prop("presentationQrLabel", "minimumSize").find("size")
    assert int(size.findtext("width")) >= 240 and int(size.findtext("height")) >= 240  # NFR-30
    labels = [name for name, w in widgets.items() if w.get("class") == "QLabel"]
    assert labels and all(prop(n, "textFormat").findtext("enum") == "Qt::PlainText" for n in labels)
    assert "openExternalLinks" not in ET.tostring(root, encoding="unicode")


def test_panel_ui_has_the_qr_widgets():
    root = ET.parse(MODULE_DIR / "Resources" / "UI" / "RemoteView.ui").getroot()  # noqa: S314
    widgets = {w.get("name"): w for w in root.iter("widget")}
    size = widgets["qrLabel"].find("property[@name='minimumSize']/size")
    assert int(size.findtext("width")) >= 240 and int(size.findtext("height")) >= 240
    for name in ("copyLinkButton", "presentButton"):
        assert widgets[name].find("property[@name='enabled']/bool").text == "false"
    assert widgets["qrLabel"].find("property[@name='visible']/bool").text == "false"


def test_links_the_segno_pin_is_the_one_the_dialog_installs():
    pinned = {p.name: p.version for p in deps.PACKAGES}
    requirements = (MODULE_DIR.parent / "requirements-dev.txt").read_text().splitlines()
    assert f"segno=={pinned['segno']}" in requirements  # the tests run the release users get
