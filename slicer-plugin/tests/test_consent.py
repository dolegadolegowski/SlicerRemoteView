"""SLC-22: the consent statement shown before Start (R-06, NFR-16)."""

from __future__ import annotations

import pytest

from remoteview_core.consent import ENCRYPTED, UNENCRYPTED, UNKNOWN_RELAY, consent_text, relay_host

#: Everything that leaves the PC with a model snapshot (protocol §4.1 clientInfo, §7 GLB extras), as the text says it.
DATA_ITEMS = (
    "surface meshes of the models shown in the 3D view",
    "clipping is not applied",
    "no images or volumes",
    "their names",
    "MRML node IDs",
    "colours",
    "opacity",
    "visibility",
    "position",
    "the Slicer, RemoteView and operating-system versions",
    "While the session runs, RemoteView also sends every change",
    "any scene you open or load",
    "does not take back what was already sent",
    "Anyone who has the session code can view the scene",
)


def test_consent_names_the_relay_host_and_everything_that_is_sent():
    text = consent_text(" wss://relay.example.org/ws ")
    assert "the relay at relay.example.org:" in text and text.endswith(ENCRYPTED)
    missing = [item for item in DATA_ITEMS if item not in text]
    assert missing == []
    assert "<" not in text and ">" not in text  # plain text (the label is Qt::PlainText as well)


def test_consent_never_shows_more_of_the_address_than_the_host():
    text = consent_text("wss://user:secret@Relay.Example.org:8443/path/ws?token=abc#frag")
    assert "the relay at relay.example.org:" in text
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
    assert consent_text(url).startswith(
        f"When you click Start session, RemoteView sends to {UNKNOWN_RELAY}:"
    )


def test_consent_says_when_the_connection_is_not_encrypted():
    assert relay_host("ws://127.0.0.1:8787/ws") == "127.0.0.1"
    for url in (
        " ws://127.0.0.1:8787/ws ",
        "ws://relay.example.org/ws",
        "ws://" + "a" * 300 + "/ws",
    ):
        assert consent_text(url).endswith(
            UNENCRYPTED
        )  # the scheme alone decides (the panel strips spaces too)
    assert (
        consent_text("wss://[::1]/ws").endswith(ENCRYPTED) and relay_host("wss://[::1]/ws") == "::1"
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
    assert "the relay at other.example.net:" in instance.ui.consentLabel.text
    assert "secret" not in instance.ui.consentLabel.text
    assert instance.controller is None  # showing the statement starts nothing (FR-02)


def test_consent_adapter_without_an_address(import_remote_view):
    instance = _widget(import_remote_view)
    assert instance.ui.consentLabel.text == consent_text("")
    assert UNKNOWN_RELAY in instance.ui.consentLabel.text
