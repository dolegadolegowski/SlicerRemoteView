"""What the panel says before *Start session* (SLC-22, SLC-55; R-06, NFR-16): which relay receives the scene.

Two sentences and a link (the owner's request of 2026-10-30: the full statement left the panel for the project page and
the module's Help tab), with one variable part, the host of the relay address being typed. Nothing else the user typed
is ever shown: no user info, port, path, query or fragment (a refused address may hold a secret, §3.1). The text is
Qt rich text because of the link: the host is HTML-escaped, and nothing else in it comes from outside. Standard library
only, so the panel can show it before any session code is loaded (FR-02).
"""

from __future__ import annotations

import html
import re
from urllib.parse import urlsplit

#: A host name or IP address as the transport accepts it (letters, digits, dots, hyphens; colons for IPv6), at most the
#: DNS limit of 253 characters — anything else is not named.
_HOST = re.compile(r"(?=.*[A-Za-z0-9])[A-Za-z0-9.:-]{1,253}")
#: The only hosts plain ws:// may reach (the transport's rule, §3.1).
_LOOPBACK = frozenset({"localhost", "127.0.0.1", "::1"})
UNKNOWN_RELAY = "the relay whose address you enter above"
ENCRYPTED = "The connection is encrypted (TLS), but the relay itself can read the scene."
UNENCRYPTED = (
    "A ws:// address is not encrypted; Start session accepts it only for a relay on this computer "
    "(development)."
)
#: Where the full description lives: what is sent, how to install and use the module (the user guide in the repository).
PROJECT_URL = "https://github.com/dolegadolegowski/SlicerRemoteView"
MORE = "What is sent and how to use RemoteView:"


def relay_host(url: str) -> str | None:
    """The host of a ``wss://`` address or of a ``ws://`` address on this computer, or ``None`` when there is none to
    name (a remote ``ws://`` host is refused at Start, so it is not named as the receiver)."""
    text = url.strip()
    if not text.startswith(("wss://", "ws://")):
        return None
    try:
        host = urlsplit(text).hostname
    except ValueError:
        return None
    if not host or not _HOST.fullmatch(host):
        return None
    return host if text.startswith("wss://") or host in _LOOPBACK else None


def consent_text(url: str) -> str:
    """The consent statement for the relay address ``url`` (as typed), as rich text with the project link: who
    receives the scene, whether the way there is encrypted, and where the full description is."""
    host = relay_host(url)
    relay = f"the relay at {html.escape(host)}" if host else UNKNOWN_RELAY
    transport = UNENCRYPTED if url.strip().startswith("ws://") else ENCRYPTED
    return (
        "Nothing leaves this computer before you click Start session. Then RemoteView sends the models and "
        f"segments shown in the 3D view, and every later change to them, to {relay}. {transport} "
        f'{MORE} <a href="{PROJECT_URL}">{PROJECT_URL}</a>'
    )
