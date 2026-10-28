"""What the panel says before *Start session* (SLC-22; R-06, NFR-16): which relay receives what.

The text is fixed English (localised in SLC-21) with one variable part, the host of the relay address being typed.
Nothing else the user typed is ever shown: no user info, port, path, query or fragment (a refused address may hold a
secret, §3.1). Standard library only, so the panel can show it before any session code is loaded (FR-02).
"""

from __future__ import annotations

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
    """The consent statement for the relay address ``url`` (as typed): who receives what, and who can see it."""
    host = relay_host(url)
    relay = f"the relay at {host}" if host else UNKNOWN_RELAY
    transport = UNENCRYPTED if url.strip().startswith("ws://") else ENCRYPTED
    return (
        f"When you click Start session, RemoteView sends to {relay}: the complete surface meshes of the models "
        "and segments shown in the 3D view (segments as Slicer's 3D view shows them — clipping is not applied; no "
        "images or volumes), their names, MRML node IDs and segment IDs, their colours, opacity, visibility and "
        "position, and the Slicer, RemoteView and operating-system versions. While the session runs, RemoteView also "
        "sends every change to them (models and segments shown, added or renamed later, and any scene you open or "
        "load) until you click Stop session. Hiding, deleting or renaming a model or segment does not take back what "
        "was already sent: the relay keeps the last scene it received for viewers who join later until the scene is "
        "sent again or the session ends. Anyone who has the session code can view the scene while the session runs. "
        f"{transport}"
    )
