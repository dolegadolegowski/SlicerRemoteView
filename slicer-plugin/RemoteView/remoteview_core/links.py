"""The join link and its QR code (SLC-11; FR-04, NFR-29, NFR-30, T6).

The link is ``https://<relay host>/j#<CODE>`` (ADR 0006: the viewer is served by the relay's own origin; protocol §10
``GET /j``). The code is the URL *fragment* only — never a path or a query — because a fragment is not sent to any
server, proxy or log (RFC 3986 §3.5, T6, NFR-15). A relay at ``wss://host/ws`` gives ``https://host/j#CODE``; the
loopback-only ``ws://`` gives ``http://``; a non-default port is kept.

The QR code is computed locally with ``segno`` (installed after consent, SLC-10; imported when a code is drawn), at
error level M, never as a Micro QR (phone cameras scan those unreliably). :func:`qr_modules` returns the module matrix
with a quiet zone of :data:`QUIET_ZONE_MODULES` (the QR standard's four; NFR-30 asks for at least two). Drawing —
scaling to at least :data:`MIN_QR_PIXELS` and painting dark on white, whatever the Slicer theme — belongs to the Qt
adapter, which uses :func:`qr_scale` and :func:`dark_runs`. Nothing here logs or stores the link: it holds the session
code.
"""

from __future__ import annotations

import math
from urllib.parse import urlsplit

from remoteview_core.transport import check_relay_url
from remoteview_core.vendored import alphabet

#: NFR-30: the link behind the QR code is at most 64 characters (a 64-character link is QR version 5 at level M; at
#: 240 px its modules are 6 px wide, which stock cameras read).
MAX_LINK_CHARS = 64
#: NFR-29/NFR-30: the QR code is at least 240 × 240 px.
MIN_QR_PIXELS = 240
QUIET_ZONE_MODULES = 4
_DEFAULT_PORTS = {"https": 443, "http": 80}


def join_url(relay_url: str, code: str) -> str:
    """The viewer link for ``code`` on the relay at ``relay_url``: ``wss://relay.example/ws`` +
    ``7KQ4X`` → ``https://relay.example/j#7KQ4X``.

    ``ValueError`` (never echoing the arguments: both can be secrets) for a relay URL the transport refuses or whose
    path is not ``/ws``, a ``code`` outside the protocol alphabet, or a link longer than :data:`MAX_LINK_CHARS`.
    """
    relay_url = check_relay_url(relay_url)
    if not alphabet.CODE_PATTERN.fullmatch(code):
        raise ValueError("not a session code")
    parts = urlsplit(relay_url)
    if parts.path != "/ws":
        # §3.1: the relay is at /ws and serves the viewer at /j on the same origin (ADR 0006); for a relay elsewhere
        # the viewer's place is unknown, and a link to the host's root could hand the code to another page
        raise ValueError("the relay is not at /ws: its viewer page is unknown")
    scheme = "https" if parts.scheme == "wss" else "http"
    host = parts.hostname or ""
    if ":" in host:  # an IPv6 literal
        host = f"[{host}]"
    port = parts.port
    if port is not None and port != _DEFAULT_PORTS[scheme]:
        host = f"{host}:{port}"
    link = f"{scheme}://{host}/j#{code}"
    if len(link) > MAX_LINK_CHARS:
        raise ValueError(f"the link is longer than {MAX_LINK_CHARS} characters (NFR-30)")
    return link


def qr_modules(link: str, *, border: int = QUIET_ZONE_MODULES) -> list[list[bool]]:
    """The QR code of ``link`` as a square matrix of modules (``True`` = dark) with ``border`` light modules all around.

    Error level M, no Micro QR. Raises ``ImportError`` when ``segno`` is not installed (the dependency step of Start
    session installs it first).
    """
    import segno  # noqa: PLC0415 — installed after consent (SLC-10), imported when a code is drawn

    qr = segno.make(link, error="m", micro=False, boost_error=False)
    light = [False] * border
    rows = [light + [bool(module) for module in row] + light for row in qr.matrix]
    width = len(rows[0]) if rows else 0
    return (
        [[False] * width for _ in range(border)] + rows + [[False] * width for _ in range(border)]
    )


def qr_scale(side_modules: int, min_pixels: int = MIN_QR_PIXELS) -> int:
    """Whole pixels per module so that the code is at least ``min_pixels`` wide and high."""
    return max(1, math.ceil(min_pixels / side_modules))


def dark_runs(modules: list[list[bool]]) -> list[tuple[int, int, int]]:
    """The dark modules as ``(x, y, width)`` runs of one row each — about half as many rectangles to paint."""
    runs = []
    for y, row in enumerate(modules):
        x = 0
        while x < len(row):
            if not row[x]:
                x += 1
                continue
            start = x
            while x < len(row) and row[x]:
                x += 1
            runs.append((start, y, x - start))
    return runs
