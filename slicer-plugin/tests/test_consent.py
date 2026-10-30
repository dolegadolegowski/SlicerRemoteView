"""SLC-22, SLC-55: the consent statement shown before Start (R-06, NFR-16): two sentences and the project link."""

from __future__ import annotations

import pytest

from remoteview_core.consent import (
    ENCRYPTED,
    MORE,
    PROJECT_URL,
    UNENCRYPTED,
    UNKNOWN_RELAY,
    consent_text,
    relay_host,
)

LINK = f'<a href="{PROJECT_URL}">{PROJECT_URL}</a>'


def test_consent_names_the_relay_host_and_links_the_project_page():
    text = consent_text(" wss://relay.example.org/ws ")
    assert text.startswith("Nothing leaves this computer before you click Start session.")
    assert "to the relay at relay.example.org." in text
    assert "models and segments shown in the 3D view, and every later change to them" in text
    assert text.endswith(f"{ENCRYPTED} {MORE} {LINK}")
    assert (
        text.count("<") == 2
    )  # the link's two tags are the only markup (the label is Qt::RichText)
    assert PROJECT_URL.startswith("https://github.com/")


def test_consent_never_shows_more_of_the_address_than_the_host():
    text = consent_text("wss://user:secret@Relay.Example.org:8443/path/ws?token=abc#frag")
    assert "the relay at relay.example.org." in text
    for part in ("user", "secret", "8443", "path", "token", "abc", "frag"):
        assert part not in text


@pytest.mark.parametrize(
    "url",
    ["", "   ", "relay.example.org", "http://relay.example.org/ws", "wss://", "wss://[::1/ws",
     "wss://exa<b>mple.org/ws", "wss://" + "a" * 254 + "/ws", "wss://résumé.example/ws", "wss://-/ws",
     "ws://relay.example.org/ws"],  # Start refuses a remote ws:// host: it is not named as the receiver
)  # fmt: skip
def test_consent_without_a_usable_address_names_no_host(url):
    assert relay_host(url) is None
    text = consent_text(url)
    assert f"to {UNKNOWN_RELAY}." in text and "<b>" not in text


def test_consent_says_when_the_connection_is_not_encrypted():
    assert relay_host("ws://127.0.0.1:8787/ws") == "127.0.0.1"
    for url in (
        " ws://127.0.0.1:8787/ws ",
        "ws://relay.example.org/ws",
        "ws://" + "a" * 300 + "/ws",
    ):
        assert f"{UNENCRYPTED} {MORE}" in consent_text(url)  # the scheme alone decides
    assert (
        f"{ENCRYPTED} {MORE}" in consent_text("wss://[::1]/ws")
        and relay_host("wss://[::1]/ws") == "::1"
    )


def test_consent_uses_the_standard_library_only():
    """The panel imports it on every keystroke before Start: no numpy, VTK or session code (FR-02)."""
    import ast  # noqa: PLC0415
    import sys  # noqa: PLC0415

    from conftest import MODULE_DIR  # noqa: PLC0415

    tree = ast.parse((MODULE_DIR / "remoteview_core" / "consent.py").read_text())
    imported = {
        alias.name.split(".")[0]
        for node in ast.walk(tree)
        if isinstance(node, ast.Import)
        for alias in node.names
    }
    imported |= {
        node.module.split(".")[0]
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom) and node.module
    }
    assert imported and imported <= set(sys.stdlib_module_names) | {"__future__"}


# --------------------------------------------------------------------------- the panel shows it before Start


def _widget(import_remote_view):
    from unittest import mock  # noqa: PLC0415

    instance = import_remote_view().RemoteViewWidget(parent=mock.MagicMock(name="parentWidget"))
    instance.setup()
    return instance


def test_consent_adapter_shows_the_statement_for_the_address_being_typed(
    import_remote_view, slicer_stubs
):
    slicer_stubs["qt"].QSettings().setValue("RemoteView/RelayURL", "wss://relay.example.org/ws")
    instance = _widget(import_remote_view)
    assert instance.ui.consentLabel.text == consent_text("wss://relay.example.org/ws")
    instance.ui.relayUrlLineEdit.connect.assert_any_call(
        "textChanged(QString)", instance.onRelayUrlChanged
    )
    instance.onRelayUrlChanged(
        "wss://user:secret@other.example.net/ws"
    )  # Qt calls this on every keystroke
    assert "the relay at other.example.net." in instance.ui.consentLabel.text
    assert "secret" not in instance.ui.consentLabel.text
    assert instance.controller is None  # showing the statement starts nothing (FR-02)


def test_consent_adapter_without_an_address(import_remote_view):
    instance = _widget(import_remote_view)
    assert instance.ui.consentLabel.text == consent_text("")
    assert UNKNOWN_RELAY in instance.ui.consentLabel.text


def test_consent_label_is_rich_text_that_opens_the_link_outside():
    """The link needs ``Qt::RichText`` and ``openExternalLinks``; the host is the only variable part, escaped."""
    import xml.etree.ElementTree as ET  # noqa: PLC0415

    from conftest import MODULE_DIR  # noqa: PLC0415

    root = ET.parse(MODULE_DIR / "Resources" / "UI" / "RemoteView.ui").getroot()  # noqa: S314 — our own file
    label = next(w for w in root.iter("widget") if w.get("name") == "consentLabel")
    props = {p.get("name"): "".join(p.itertext()).strip() for p in label.findall("property")}
    assert props["textFormat"] == "Qt::RichText" and props["openExternalLinks"] == "true"
