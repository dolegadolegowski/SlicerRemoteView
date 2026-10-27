"""Publisher-side protocol core (``docs/protocol.md`` §4 session, §6 snapshot, §8 updates, §9 heartbeat/errors).

Pure state machine and message builders — no sockets, no threads, no Slicer/Qt (CLAUDE.md rule 10).

Threading: :class:`ProtocolClient` is **not** thread-safe and is used on the Slicer main thread only. The transport
thread (SLC-08) puts parsed inbound frames on a queue; the main-thread ``qt.QTimer`` pump (SLC-09) drains it into
:meth:`ProtocolClient.handle` and passes the returned and built messages to the transport's outbound queue; the panel
renders :attr:`ProtocolClient.state` and :attr:`ProtocolClient.last_error` (architecture §6).

States (``SessionState``)::

    idle ──start()──▶ connecting ──session.created──▶ created ──begin_snapshot()──▶ active
                          │                              │                            │
                          └─ error (CAPACITY, …) ─▶ closed ◀─ close() / session.expired / fatal error
    created/active ──transport_lost()──▶ grace ──(SLC-17: session.resume)──▶ resuming ──▶ active

Scene updates (§8, SLC-16): :meth:`ProtocolClient.send_changes`, :meth:`~ProtocolClient.send_removed` and
:meth:`~ProtocolClient.announce_added` build ``scene.update``/``scene.nodeRemoved``/``scene.nodeAdded`` on the shared
version counter. While a snapshot is in flight (until its ``scene.snapshot.ack``), while a snapshot is needed
(:attr:`~ProtocolClient.snapshot_needed`) and before the first snapshot, changes and removals are **held** and the
ack's replies carry them (§6.2); a snapshot drops what was held before its ``begin`` — its export already has it.

Secrets: the ``publisherToken`` lives only in memory inside a :class:`Secret` whose ``repr``/``str`` are redacted;
neither the token nor the session code is ever logged (§4.2, T4, T6, NFR-17). Log lines carry fixed text, known
message types and validated upper-case enum values only.
"""

from __future__ import annotations

import enum
import json
import logging
import math
import numbers
import re
import struct
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any, ClassVar, NamedTuple

from remoteview_core import __version__
from remoteview_core.vendored import alphabet, chunk_header

_log = logging.getLogger(__name__)

#: Envelope version (§2); equal to ``remoteview_protocol.PROTOCOL_VERSION`` (asserted in tests).
PROTOCOL_VERSION = "1.0"

APP_NAME = "SlicerRemoteView"
PROFILES = ("mobile", "quest2", "quest3")
#: §6.2: chunkSize SHOULD be 1 MiB (lowered to the relay's announced ``maxChunkBytes`` when that is smaller).
DEFAULT_CHUNK_SIZE = chunk_header.MAX_CHUNK_SIZE
#: Errors after which the relay ignores the in-flight snapshot (§6.2–6.4, §9.2).
_SNAPSHOT_REJECTIONS = frozenset(
    {"PAYLOAD_TOO_LARGE", "CAPACITY", "BAD_SEQUENCE", "CHECKSUM_MISMATCH"}
)
#: Errors after which the relay closes the publisher socket for good (§9.2–9.3: 4003, 4001, 4000) — no resume.
_FATAL_ERRORS = frozenset({"UNAUTHORIZED", "SESSION_CLOSED", "UNSUPPORTED_VERSION"})
#: Top-level ``error.details`` keys §9.2 forbids (error.schema.json); such an error is dropped as invalid.
_FORBIDDEN_DETAILS = ("code", "token", "publisherToken", "viewerToken")
#: §6.2: v1 snapshots may use KHR_mesh_quantization only.
ALLOWED_EXTENSIONS = frozenset({"KHR_mesh_quantization"})
#: WebSocket close codes after which the session cannot be resumed (§9.3) → ``closed`` with this reason.
TERMINAL_CLOSE_CODES = MappingProxyType(
    {
        1008: "POLICY_VIOLATION",
        4000: "UNSUPPORTED_VERSION",
        4001: "SESSION_CLOSED",
        4002: "SESSION_EXPIRED",
        4003: "UNAUTHORIZED",
        4011: "REPLACED",  # another connection took over with the same credentials (T4: never resume)
    }
)
_UINT32_MAX = 0xFFFF_FFFF


class SessionState(enum.Enum):
    IDLE = "idle"
    CONNECTING = "connecting"
    CREATED = "created"
    ACTIVE = "active"
    GRACE = "grace"
    RESUMING = "resuming"
    CLOSED = "closed"


class ProtocolStateError(RuntimeError):
    """A builder was called in a state where the protocol does not allow that message."""


class MessageTooLargeError(ValueError):
    """One item (a change, a removed ID, an added node) does not fit the relay's ``maxTextBytes`` (§3.3)."""


class Secret:
    """A credential kept in memory only; ``repr``/``str``/format never reveal it (T4, NFR-17)."""

    __slots__ = ("_value",)

    def __init__(self, value: str) -> None:
        self._value = value

    def reveal(self) -> str:
        return self._value

    def __repr__(self) -> str:
        return "Secret(<redacted>)"

    __str__ = __repr__

    def __format__(self, _spec: str) -> str:
        return repr(self)

    def __reduce__(self) -> Any:
        raise TypeError("Secret cannot be pickled")


def envelope(type_: str, message_id: str | None = None, **fields: Any) -> dict[str, Any]:
    """A message dict ``{"protocolVersion": "1.0", "type": …, "id": …, **fields}`` (§3.2).

    Same shape as ``remoteview_protocol.envelope.make``, which cannot be imported without ``jsonschema`` (not a
    Slicer runtime dependency — see ``remoteview_core.vendored``).
    """
    message: dict[str, Any] = {"protocolVersion": PROTOCOL_VERSION, "type": type_}
    if message_id is not None:
        message["id"] = message_id
    message.update(fields)
    return message


def _uint(value: Any, minimum: int = 0, maximum: int = _UINT32_MAX) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and minimum <= value <= maximum


class SceneVersionCounter:
    """The per-session ``sceneVersion`` counter owned by the publisher (§8.4).

    ``0`` means nothing published; :meth:`allocate` returns strictly increasing uint32 values shared by snapshots
    and updates; a fallback ``session.create`` restarts at 1 (:meth:`reset`), ``session.resume`` continues from the
    relay's ``sceneVersion`` (:meth:`continue_from`). A version is never reused, even when the relay rejected it.
    """

    def __init__(self) -> None:
        self._last = 0

    @property
    def last(self) -> int:
        return self._last

    def allocate(self) -> int:
        if self._last >= _UINT32_MAX:
            raise OverflowError("sceneVersion exhausted the uint32 range; start a new session")
        self._last += 1
        return self._last

    def reset(self) -> None:
        self._last = 0

    def continue_from(self, version: int) -> None:
        if not _uint(version):
            raise ValueError("sceneVersion must be a uint32")
        self._last = version


@dataclass(frozen=True)
class ErrorInfo:
    """The last ``error`` from the relay (§9.2), or ``UNSUPPORTED_VERSION`` detected locally (§2).

    ``code`` is a validated upper-case enum value, safe to log and to map to UI text (SLC-18). ``message`` (relay
    free text for developers, never shown raw to users — §9.2) and ``details`` (relay data; errors carrying the
    forbidden top-level keys ``code``/``token``/``publisherToken``/``viewerToken`` are dropped by the inbound checks)
    are left out of the ``repr``, so logging an ``ErrorInfo`` cannot carry them.
    """

    code: str
    message: str = field(repr=False)
    retryable: bool | None
    reply_to: str | None
    details: Mapping[str, Any] = field(default_factory=dict, repr=False)


class SnapshotMessages(NamedTuple):
    """``scene.snapshot.begin`` + binary chunk frames + ``scene.snapshot.end`` for one GLB (§6.1).

    ``chunks`` is a one-shot iterator: frames are encoded lazily, one chunk copy at a time.
    """

    begin: dict[str, Any]
    chunks: Iterator[bytes]
    end: dict[str, Any]


_NODE_ID = re.compile(r"[A-Za-z0-9_./:-]{1,128}")  # defs.schema.json#/definitions/nodeId (§3.3)
NODE_KINDS = ("model", "segment")  # defs.schema.json#/definitions/nodeKind


def _check_node_id(node_id: Any) -> None:
    """A §3.3 node ID, or ``ValueError`` — whose text never repeats the ID (T7: it may carry a name)."""
    if not isinstance(node_id, str) or _NODE_ID.fullmatch(node_id) is None:
        raise ValueError("node ID must match [A-Za-z0-9_./:-]{1,128} (§3.3)")


def _number(value: Any, what: str, low: float = -math.inf, high: float = math.inf) -> float:
    if not isinstance(value, numbers.Real) or isinstance(value, bool):
        raise TypeError(f"{what} must be a number")
    try:
        number = float(value)
    except OverflowError:  # an int beyond the double range
        raise ValueError(f"{what} must be finite") from None
    if not (math.isfinite(number) and low <= number <= high):
        bounds = "" if math.isinf(low) and math.isinf(high) else f" and within [{low}, {high}]"
        raise ValueError(f"{what} must be finite{bounds}")
    return number


@dataclass(frozen=True)
class NodeChange:
    """One item of ``scene.update.changes`` (§8.1): new visual properties of the node ``node_id``, ``None`` = unchanged.

    Checked when built like ``defs.schema.json#/definitions/nodeChange`` (in Slicer the only check: ``jsonschema`` is
    absent): a §3.3 node ID, at least one property, ``color`` three numbers in 0..1, ``opacity`` in 0..1, ``matrix``
    16 finite numbers — column-major, glTF space, replacing ``T.matrix`` (§7.2). Never a name (§8.3). The ``repr``
    shows which properties are set, not the node ID (T7).
    """

    node_id: str = field(repr=False)
    visible: bool | None = None
    color: tuple[float, float, float] | None = None
    opacity: float | None = None
    matrix: tuple[float, ...] | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        _check_node_id(self.node_id)
        if self.visible is not None and not isinstance(self.visible, bool):
            raise TypeError("visible must be a bool")
        if self.color is not None:
            color = tuple(_number(c, "color", 0.0, 1.0) for c in self.color)
            if len(color) != 3:
                raise ValueError("color must be [r, g, b]")
            object.__setattr__(self, "color", color)
        if self.opacity is not None:
            object.__setattr__(self, "opacity", _number(self.opacity, "opacity", 0.0, 1.0))
        if self.matrix is not None:
            matrix = tuple(_number(m, "matrix") for m in self.matrix)
            if len(matrix) != 16:
                raise ValueError("matrix must be 16 numbers, column-major (§8.1)")
            object.__setattr__(self, "matrix", matrix)
        if (
            self.visible is None
            and self.color is None
            and self.opacity is None
            and self.matrix is None
        ):
            raise ValueError("a change sets at least one of visible, color, opacity, matrix (§8.1)")

    def merged(self, newer: NodeChange) -> NodeChange:
        """This change followed by ``newer`` of the same node: last writer wins per property (§8.1)."""
        if newer.node_id != self.node_id:
            raise ValueError("changes of different nodes do not merge")
        return NodeChange(
            self.node_id,
            visible=self.visible if newer.visible is None else newer.visible,
            color=self.color if newer.color is None else newer.color,
            opacity=self.opacity if newer.opacity is None else newer.opacity,
            matrix=self.matrix if newer.matrix is None else newer.matrix,
        )

    def to_json(self) -> dict[str, Any]:
        item: dict[str, Any] = {"nodeId": self.node_id}
        if self.visible is not None:
            item["visible"] = self.visible
        if self.color is not None:
            item["color"] = list(self.color)
        if self.opacity is not None:
            item["opacity"] = self.opacity
        if self.matrix is not None:
            item["matrix"] = list(self.matrix)
        return item


def encoded_size(message: Any) -> int:
    """UTF-8 bytes of ``message`` as the transport sends it: compact JSON, one text frame (§3.2, §3.3)."""
    text = json.dumps(message, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return len(text.encode("utf-8"))


def split_items(
    items: Sequence[Any], *, base_size: int, max_items: int, max_bytes: int
) -> list[list[Any]]:
    """``items`` in order, cut into groups of at most ``max_items`` whose message — ``base_size`` bytes with an empty
    list, plus each item and the commas between them — stays within ``max_bytes`` (§3.3)."""
    groups: list[list[Any]] = []
    group: list[Any] = []
    size = base_size
    for item in items:
        item_size = encoded_size(item)
        if group and (len(group) >= max_items or size + 1 + item_size > max_bytes):
            groups.append(group)
            group, size = [], base_size
        added = item_size + (1 if group else 0)
        if size + added > max_bytes:
            raise MessageTooLargeError("one item does not fit the relay's maxTextBytes (§3.3)")
        group.append(item)
        size += added
    if group:
        groups.append(group)
    return groups


def make_client_info(slicer_version: str, platform: str) -> dict[str, str]:
    """``clientInfo`` for ``session.create``/``session.resume`` (§4.1): no device identifiers or user names."""
    info = {
        "app": APP_NAME,
        "version": __version__,
        "platform": f"Slicer {slicer_version} / {platform}",
    }
    if len(info["platform"]) > 64:
        raise ValueError("clientInfo.platform must be ≤ 64 characters")
    return info


def glb_extensions(glb: bytes | bytearray | memoryview) -> tuple[list[str], list[str]]:
    """``(extensionsUsed, extensionsRequired)`` read from a GLB's JSON chunk (so ``begin`` matches the file)."""
    view = memoryview(glb)
    if view.nbytes < 20:
        raise ValueError("not a GLB: shorter than the header")
    magic, version, length, json_length, json_type = struct.unpack_from("<IIIII", view, 0)
    if magic != 0x46546C67 or version != 2 or length != view.nbytes or json_type != 0x4E4F534A:
        raise ValueError("not a glTF 2.0 binary container")
    if 20 + json_length > view.nbytes:
        raise ValueError("GLB JSON chunk is truncated")
    document = json.loads(bytes(view[20 : 20 + json_length]))
    if not isinstance(document, dict):
        raise ValueError("GLB JSON chunk is not a glTF document")
    lists = [document.get(key, []) for key in ("extensionsUsed", "extensionsRequired")]
    for names in lists:
        if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
            raise ValueError("GLB extensionsUsed/extensionsRequired must be lists of strings")
    return lists[0], lists[1]


def build_snapshot_messages(  # noqa: PLR0913 — one keyword per scene.snapshot.begin field (§6.2)
    glb: bytes,
    scene_version: int,
    *,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    profile: str,
    node_count: int,
    triangle_count: int,
    message_id: str | None = None,
    end_message_id: str | None = None,
) -> SnapshotMessages:
    """Messages for one snapshot (§6.2–6.4) using the vendored chunk codec.

    Raises ``ValueError`` for values the relay would reject (chunk size outside 64 KiB–1 MiB, more than 1,024
    chunks, empty or > 64 MiB, extensions other than ``KHR_mesh_quantization``) before anything is sent.
    ``message_id``/``end_message_id`` let the relay's ``error`` name the ``begin``/``end`` it answers (``replyTo``,
    §3.2).
    """
    if not _uint(scene_version, 1):
        raise ValueError("sceneVersion of a snapshot must be a uint32 ≥ 1 (§8.4)")
    if profile not in PROFILES:
        raise ValueError(f"profile must be one of {PROFILES}")
    if not (_uint(node_count) and _uint(triangle_count)):
        raise ValueError("nodeCount and triangleCount must be uint32 values")
    data = bytes(glb)
    # Validates the sizes eagerly; the pieces are memoryviews, not copies.
    pieces = list(chunk_header.chunkify(data, chunk_size))
    used, required = glb_extensions(data)
    unique = len(set(used)) == len(used) and len(set(required)) == len(required)
    if not unique or not set(required) <= set(used) <= ALLOWED_EXTENSIONS:
        raise ValueError(
            f"GLB extensions must be unique and within {sorted(ALLOWED_EXTENSIONS)} (§6.2)"
        )
    digest = chunk_header.sha256_hex(data)
    begin = envelope(
        "scene.snapshot.begin",
        message_id,
        sceneVersion=scene_version,
        byteLength=len(data),
        sha256=digest,
        chunkCount=len(pieces),
        chunkSize=chunk_size,
        format="glb",
        extensionsUsed=used,
        extensionsRequired=required,
        profile=profile,
        nodeCount=node_count,
        triangleCount=triangle_count,
    )

    def frames() -> Iterator[bytes]:
        for index, payload in pieces:
            yield chunk_header.encode_chunk_frame(
                chunk_header.ChunkHeader(scene_version, index), payload
            )

    end = envelope("scene.snapshot.end", end_message_id, sceneVersion=scene_version, sha256=digest)
    return SnapshotMessages(begin, frames(), end)


# Patterns are used with fullmatch: `$` would also accept a trailing newline. [0-9], not \d (Unicode digits).
_TOKEN = re.compile(r"[A-Za-z0-9_-]{43,256}")  # defs.schema.json#/definitions/token
_VERSION = re.compile(r"(0|[1-9][0-9]{0,3})\.([0-9]{1,4})")  # protocolVersion "MAJOR.MINOR" (§2)
#: Relay-supplied enum values (error codes, reasons) that end up in logs/UI: upper-case words only, so an unknown
#: future value is tolerated (§14) but nothing else (no newlines, no free text) can reach a log line.
_ENUM_VALUE = re.compile(r"[A-Z][A-Z0-9_]{0,63}")
_SESSION_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
#: IDs of the scene.update / scene.nodeRemoved / scene.nodeAdded messages (``ProtocolClient._id("u")``).
_UPDATE_ID = re.compile(r"u-([0-9]{1,18})")
#: (minimum, maximum) per ``session.created.limits`` key (defs.schema.json#/definitions/limits).
_LIMITS = {
    "maxSnapshotBytes": (1, chunk_header.MAX_SNAPSHOT_BYTES),
    "maxChunkBytes": (chunk_header.MIN_CHUNK_SIZE, chunk_header.MAX_CHUNK_SIZE),
    "maxTextBytes": (1, 262_144),
    "maxChanges": (1, 1000),
}


def _short_str(value: Any, maximum: int = 1024) -> bool:
    return isinstance(value, str) and 0 < len(value) <= maximum


def _matches(value: Any, pattern: re.Pattern[str]) -> bool:
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def _valid_ttl(ttl: Any) -> bool:
    return isinstance(ttl, Mapping) and all(
        _uint(ttl.get(k), 0, 2**63 - 1) for k in ("graceS", "idleS", "maxLifetimeS", "expiresAt")
    )


def _valid_created(m: Mapping[str, Any]) -> bool:
    limits = m.get("limits")
    return (
        _matches(m.get("sessionId"), _SESSION_ID)
        and isinstance(m.get("code"), str)
        and alphabet.is_code(m["code"])  # fullmatch of the 31-symbol alphabet (§4.2)
        and _matches(m.get("publisherToken"), _TOKEN)
        and _uint(m.get("viewerLimit"), 1, 20)
        and _valid_ttl(m.get("ttl"))
        and isinstance(limits, Mapping)
        and all(_uint(limits.get(k), low, high) for k, (low, high) in _LIMITS.items())
    )


def _valid_viewer_count(m: Mapping[str, Any]) -> bool:
    platforms = m.get("platforms")
    return (
        _uint(m.get("viewerCount"))
        and _uint(m.get("viewerLimit"), 1, 20)
        and isinstance(platforms, Mapping)
        and all(isinstance(k, str) and _uint(v) for k, v in platforms.items())
    )


#: The viewer platforms of §5.1 (defs.schema.json#/definitions/platform). ``viewer.count`` keys come from viewers'
#: free-form ``clientInfo.platform``; every other name counts as ``other`` (§14), so no viewer-chosen string reaches
#: the presenter's UI or logs.
KNOWN_PLATFORMS = frozenset({"web", "quest-browser", "quest2", "quest3", "other"})


def _platform_counts(platforms: Mapping[str, int]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for name, count in platforms.items():
        key = name if name in KNOWN_PLATFORMS else "other"
        counts[key] = counts.get(key, 0) + count
    return counts


def _valid_error(m: Mapping[str, Any]) -> bool:
    details = m.get("details", {})
    return (
        _matches(m.get("code"), _ENUM_VALUE)
        and _short_str(m.get("message"))
        and isinstance(details, Mapping)
        and not any(key in details for key in _FORBIDDEN_DETAILS)
        and ("retryable" not in m or isinstance(m["retryable"], bool))
    )


_SESSION_END_TYPES = frozenset({"session.expired", "session.closed"})


def _valid_session_end(m: Mapping[str, Any]) -> bool:
    return _matches(m.get("sessionId"), _SESSION_ID) and _matches(m.get("reason"), _ENUM_VALUE)


#: Checks for the fields each handler reads (§4, §5.3, §6.4, §9). They run always — in Slicer ``jsonschema`` is
#: absent, so this is the only inbound validation there — and an injected ``validate`` adds to them.
_INBOUND_CHECKS: Mapping[str, Callable[[Mapping[str, Any]], bool]] = MappingProxyType(
    {
        "session.created": _valid_created,
        "session.expiring": lambda m: True,  # nothing is read from it
        "session.renewed": lambda m: _valid_ttl(m.get("ttl")),
        "viewer.count": _valid_viewer_count,
        "scene.snapshot.ack": lambda m: _uint(m.get("sceneVersion"), 1),
        "pong": lambda m: True,  # only the envelope's replyTo is read
        "error": _valid_error,
        "session.expired": _valid_session_end,
        "session.closed": _valid_session_end,
    }
)


class ProtocolClient:
    """Publisher session state fed by inbound messages; builds every outbound message (§4, §6, §9).

    Inbound messages always pass the stdlib-only checks of the fields each handler reads (``_INBOUND_CHECKS``) —
    in Slicer that is the only validation, because ``jsonschema`` is not installed (FR-16). ``validate`` is an
    optional extra check injected by the tests (``remoteview_protocol.schemas.validate_message`` bound to compiled
    schemas; it returns a list of issues, empty when valid): every outbound message is checked before it is
    returned (a builder bug fails loudly instead of earning ``INVALID_MESSAGE`` strikes) and every inbound message
    before it changes state. Inbound messages that fail are ignored and counted in :attr:`invalid_inbound`;
    :attr:`last_error` keeps the last real relay error. Builders validate before they change any state.
    """

    def __init__(
        self,
        client_info: Mapping[str, Any],
        *,
        validate: Callable[[dict[str, Any]], Sequence[Any]] | None = None,
        auto_renew: bool = True,
    ) -> None:
        self.client_info = dict(client_info)
        self._validate = validate
        self.auto_renew = auto_renew
        self.versions = SceneVersionCounter()
        self._next_id = 0
        self._reset_session()
        self.state = SessionState.IDLE

    def _reset_session(self) -> None:
        self.session_id: str | None = None
        self.code: str | None = None
        self._publisher_token: Secret | None = None
        self.profile: str | None = None
        self.viewer_limit: int | None = None
        self.viewer_count = 0
        self.platforms: dict[str, int] = {}
        self.ttl: dict[str, Any] | None = None
        self.limits: dict[str, Any] | None = None
        self.close_reason: str | None = None
        self.last_error: ErrorInfo | None = None
        #: Inbound messages ignored because they failed the checks, and the type (or "envelope") of the last one.
        self.invalid_inbound = 0
        self.last_invalid_type: str | None = None
        self.snapshot_in_flight: int | None = None
        self._snapshot_ids: frozenset[str] = frozenset()
        #: Last snapshot the relay acknowledged; ``accepted_version`` is the last acknowledged ``sceneVersion`` — the
        #: same, as the relay acknowledges snapshots only (``scene.update`` has no ack, §8.1).
        self.snapshot_version: int | None = None
        self.accepted_version = 0
        #: Held while a snapshot is in flight or needed (§6.2): node ID → merged change, and removed node IDs.
        self._held_changes: dict[str, NodeChange] = {}
        self._held_removed: dict[str, None] = {}
        self._snapshot_needed = False
        #: Number part of the current snapshot's ``end`` ID (taken with its ``begin`` ID): an error answering an update
        #: with a higher number concerns the state after that snapshot (§8.1 re-sync); older ones are superseded by it.
        self._epoch = 0
        self._pending_create_id: str | None = None
        self._pending_ping_id: str | None = None
        self.versions.reset()

    def __repr__(self) -> str:  # no code, no token (T4, T6)
        return f"ProtocolClient(state={self.state.value}, sceneVersion={self.versions.last})"

    @property
    def next_scene_version(self) -> int:
        """The ``sceneVersion`` the next snapshot or update gets (§8.4), so a GLB's root extras can name it before
        :meth:`begin_snapshot` allocates it; reading it allocates nothing."""
        return self.versions.last + 1

    @property
    def snapshot_needed(self) -> bool:
        """The viewers can only be brought up to date by a new snapshot (§8.1 re-sync): the relay refused a snapshot or
        an update sent after the last ``begin``, the connection dropped, ``scene.nodeAdded`` was sent and its snapshot
        did not begin yet (§8.2), or the caller asked for one (:meth:`require_snapshot`). :meth:`begin_snapshot`
        clears it."""
        return self._snapshot_needed

    @property
    def updates_held(self) -> bool:
        """Changes and removals are held now (see the module docstring)."""
        return (
            self._snapshot_needed
            or self.snapshot_in_flight is not None
            or self.snapshot_version is None
        )

    @property
    def has_publisher_token(self) -> bool:
        return self._publisher_token is not None

    def publisher_token(self) -> Secret | None:
        """The resume credential for ``session.resume`` (SLC-17); wrapped so it cannot leak through ``repr``."""
        return self._publisher_token

    @property
    def ping_outstanding(self) -> bool:
        return self._pending_ping_id is not None

    # ------------------------------------------------------------------ outbound builders

    def _id(self, prefix: str = "p") -> str:
        self._next_id += 1
        return f"{prefix}-{self._next_id}"

    def _out(self, message: dict[str, Any]) -> dict[str, Any]:
        if self._validate is not None and (issues := self._validate(message)):
            where = getattr(issues[0], "instance_path", issues[0])
            raise ValueError(f"outbound {message.get('type')} invalid at {where}")
        return message

    def start(self, profile: str, preferred_code: str | None = None) -> dict[str, Any]:
        """``idle``/``closed`` → ``connecting``; returns ``session.create`` (§4.1).

        Call only after the user clicked Start (opt-in, FR-02).
        """
        if self.state not in (SessionState.IDLE, SessionState.CLOSED):
            raise ProtocolStateError(f"cannot start a session in state {self.state.value}")
        message_id = self._id()
        message = self._out(
            build_session_create(self.client_info, profile, preferred_code, message_id=message_id)
        )
        self._reset_session()
        self._pending_create_id = message_id
        self.profile = profile
        self.state = SessionState.CONNECTING
        _log.info("session: connecting")
        return message

    def begin_snapshot(
        self,
        glb: bytes,
        *,
        node_count: int,
        triangle_count: int,
        chunk_size: int | None = None,
    ) -> SnapshotMessages:
        """Allocate the next ``sceneVersion`` and build the snapshot messages; ``created`` → ``active`` (§6, §8.4).

        A new snapshot while one is in flight supersedes it (§6.2). Size limits announced in
        ``session.created.limits`` are enforced here so an oversize GLB never leaves the PC; ``chunk_size``
        defaults to 1 MiB or the relay's smaller ``maxChunkBytes``. The SHA-256 is computed on the calling thread.
        """
        if (
            self.state not in (SessionState.CREATED, SessionState.ACTIVE)
            or self.limits is None
            or not self.profile
        ):
            raise ProtocolStateError(f"cannot send a snapshot in state {self.state.value}")
        if chunk_size is None:
            chunk_size = min(DEFAULT_CHUNK_SIZE, self.limits["maxChunkBytes"])
        if len(glb) > self.limits["maxSnapshotBytes"]:
            raise ValueError("snapshot exceeds the relay's maxSnapshotBytes (§3.3)")
        if chunk_size > self.limits["maxChunkBytes"]:
            raise ValueError("chunkSize exceeds the relay's maxChunkBytes (§3.3)")
        version = self.versions.last + 1  # allocated only once the messages are built and validated
        begin_id, end_id = self._id(), self._id()
        messages = build_snapshot_messages(
            glb,
            version,
            chunk_size=chunk_size,
            profile=self.profile,
            node_count=node_count,
            triangle_count=triangle_count,
            message_id=begin_id,
            end_message_id=end_id,
        )
        self._out(messages.begin)
        self._out(messages.end)
        self.versions.allocate()
        self.snapshot_in_flight = version
        self._snapshot_ids = frozenset({begin_id, end_id})
        self.state = SessionState.ACTIVE
        # the export behind this GLB already holds every change made before it
        self._held_changes.clear()
        self._held_removed.clear()
        self._snapshot_needed = False
        self._epoch = self._next_id
        return messages

    def send_changes(self, changes: Iterable[NodeChange]) -> list[dict[str, Any]]:
        """``scene.update`` messages for ``changes`` (§8.1), several changes of one node merged (last writer wins per
        property); each message holds at most ``limits.maxChanges`` items and ``limits.maxTextBytes`` bytes (§3.3) and
        takes the next ``sceneVersion`` with ``baseVersion`` = the one before (§8.4). Empty when held (see the module
        docstring): the changes are then kept and sent with the snapshot's ack. Versions are allocated only once every
        message is built and checked. Empty too, with :attr:`snapshot_needed` set, when one change does not fit the
        relay's ``maxTextBytes``: only a snapshot can show it."""
        self._require_live("send scene changes")
        merged: dict[str, NodeChange] = {}
        for change in changes:
            if not isinstance(change, NodeChange):
                raise TypeError("changes must be NodeChange items")
            earlier = merged.get(change.node_id)
            merged[change.node_id] = change if earlier is None else earlier.merged(change)
        if self.updates_held:
            for node_id, change in merged.items():
                if node_id in self._held_removed:
                    continue  # the node is gone: its removal is held already
                earlier = self._held_changes.get(node_id)
                self._held_changes[node_id] = change if earlier is None else earlier.merged(change)
            return []
        return self._send_versioned(
            [("scene.update", "changes", [c.to_json() for c in merged.values()])]
        )

    def send_removed(self, node_ids: Iterable[str]) -> list[dict[str, Any]]:
        """``scene.nodeRemoved`` messages for ``node_ids`` (§8.2; at most ``limits.maxChanges`` IDs each), versioned
        like :meth:`send_changes`; held the same way, a removal dropping the node's held changes."""
        self._require_live("send removed nodes")
        if isinstance(node_ids, (str, bytes)):  # one ID by mistake: its letters are valid IDs too
            raise TypeError("node_ids must be an iterable of node IDs, not one ID")
        ids = list(dict.fromkeys(node_ids))
        for node_id in ids:
            _check_node_id(node_id)
        if self.updates_held:
            for node_id in ids:
                self._held_changes.pop(node_id, None)
                self._held_removed[node_id] = None
            return []
        return self._send_versioned([("scene.nodeRemoved", "nodeIds", ids)])

    def announce_added(self, nodes: Iterable[tuple[str, str]]) -> dict[str, Any] | None:
        """``scene.nodeAdded{snapshotFollows: true}`` for the ``(nodeId, kind)`` pairs the next snapshot adds (§8.2).

        A hint viewers may ignore, so ``None`` when it would not be correct now: no nodes, more than fit one message
        (``limits.maxChanges``, ``limits.maxTextBytes``), or updates held (a snapshot in flight or needed — the snapshot
        that follows says it all); no version is used then. After it a snapshot MUST follow (§8.2):
        :attr:`snapshot_needed` is true until :meth:`begin_snapshot`. Only IDs that passed collect's ID rules for the
        current *Hide node names* setting may be announced (T7: the hint goes out before the export checks them).
        """
        self._require_live("announce added nodes")
        kinds: dict[str, str] = {}
        for node_id, kind in nodes:
            _check_node_id(node_id)
            if kind not in NODE_KINDS:
                raise ValueError(f"kind must be one of {NODE_KINDS}")
            kinds.setdefault(node_id, kind)  # one entry per node ID
        items = [{"nodeId": node_id, "kind": kind} for node_id, kind in kinds.items()]
        if not items or self.updates_held:
            return None
        try:
            planned = self._plan([("scene.nodeAdded", "nodes", items)], snapshot_follows=True)
            if len(planned) != 1:
                return None
            [message] = self._build_versioned(planned)
        except MessageTooLargeError:
            return None
        self._snapshot_needed = True
        return message

    def require_snapshot(self) -> None:
        """Only a new snapshot can bring the viewers up to date, but none begins now (an export too large, a back-off,
        SLC-29): set :attr:`snapshot_needed`, so changes and removals stay held until :meth:`begin_snapshot` clears
        it. Sends nothing and uses no version; does nothing without a session (``idle``, ``connecting``, ``closed``)."""
        if self.state in (
            SessionState.CREATED,
            SessionState.ACTIVE,
            SessionState.GRACE,
            SessionState.RESUMING,
        ):
            self._snapshot_needed = True

    def _send_versioned(self, parts: Sequence[tuple[str, str, list[Any]]]) -> list[dict[str, Any]]:
        try:
            return self._build_versioned(self._plan(parts))
        except MessageTooLargeError:
            # a relay whose maxTextBytes cannot carry one item: a snapshot can show it
            self._snapshot_needed = True
            return []

    def _plan(
        self, parts: Sequence[tuple[str, str, list[Any]]], *, snapshot_follows: bool = False
    ) -> list[tuple[str, str, list[Any], dict[str, Any]]]:
        """Each ``(type, key, items)`` part cut into the messages it needs, in order (§3.3)."""
        limits = self._live_limits()
        max_items, max_bytes = limits["maxChanges"], limits["maxTextBytes"]
        extra = {"snapshotFollows": True} if snapshot_follows else {}
        planned: list[tuple[str, str, list[Any], dict[str, Any]]] = []
        for type_, key, items in parts:
            # the longest envelope: 32-character ID (§3.2), uint32 versions
            empty = envelope(
                type_,
                "u-" + "9" * 30,
                sceneVersion=_UINT32_MAX,
                baseVersion=_UINT32_MAX,
                **{key: []},
                **extra,
            )
            groups = split_items(
                items, base_size=encoded_size(empty), max_items=max_items, max_bytes=max_bytes
            )
            planned += [(type_, key, group, extra) for group in groups]
        return planned

    def _build_versioned(
        self, planned: Sequence[tuple[str, str, list[Any], dict[str, Any]]]
    ) -> list[dict[str, Any]]:
        """The messages of :meth:`_plan` on consecutive versions (§8.4), allocated once all are built and checked."""
        max_bytes = self._live_limits()["maxTextBytes"]
        first = self.versions.last + 1
        if first + len(planned) - 1 > _UINT32_MAX:
            raise OverflowError("sceneVersion exhausted the uint32 range; start a new session")
        messages = []
        for offset, (type_, key, group, extra) in enumerate(planned):
            message = envelope(
                type_,
                self._id("u"),
                sceneVersion=first + offset,
                baseVersion=first + offset - 1,
                **{key: group},
                **extra,
            )
            if encoded_size(message) > max_bytes:  # the plan is an upper bound: never reached
                raise MessageTooLargeError("message over the relay's maxTextBytes (§3.3)")
            messages.append(self._out(message))
        for _ in messages:
            self.versions.allocate()
        return messages

    def _release_held(self) -> list[dict[str, Any]]:
        """The changes and removals held during the snapshot just acknowledged, on top of it (§6.2)."""
        changes = [c.to_json() for c in self._held_changes.values()]
        removed = list(self._held_removed)
        self._held_changes.clear()
        self._held_removed.clear()
        parts = [
            part
            for part in (
                ("scene.update", "changes", changes),
                ("scene.nodeRemoved", "nodeIds", removed),
            )
            if part[2]
        ]
        try:
            return self._build_versioned(self._plan(parts))
        except (MessageTooLargeError, OverflowError):
            # inside handle(), which never raises for relay input: e.g. a maxTextBytes too small for one change
            self._snapshot_needed = True
            return []

    def build_session_renew(self) -> dict[str, Any]:
        self._require_live("renew")
        return self._out(envelope("session.renew", self._id()))

    def build_ping(self) -> dict[str, Any]:
        """Application heartbeat (§9.1) while a socket is open: one every 15 s, ``pong`` expected within 10 s.

        SLC-08 owns the timing; :attr:`ping_outstanding` tells whether the last ping is still unanswered.
        """
        if self.state not in (
            SessionState.CONNECTING,
            SessionState.CREATED,
            SessionState.ACTIVE,
            SessionState.RESUMING,
        ):
            raise ProtocolStateError(f"cannot ping in state {self.state.value}")
        ping_id = self._id("hb")
        message = self._out(envelope("ping", ping_id))
        self._pending_ping_id = ping_id
        return message

    def close(self) -> dict[str, Any] | None:
        """User clicked Stop: returns ``session.close{USER_STOPPED}`` (or ``None`` if nothing is open); → ``closed``.

        The token is dropped from memory right away — a closed session cannot be resumed (§4.5). In ``grace`` there
        is no socket to send on: nothing is returned and the relay expires the session when the grace period ends
        (``PUBLISHER_GONE``, §9.1).
        """
        if self.state in (SessionState.IDLE, SessionState.CLOSED):
            return None
        if self.state is SessionState.GRACE:
            self._close("USER_STOPPED")
            return None
        message = self._out(envelope("session.close", self._id(), reason="USER_STOPPED"))
        self._close("USER_STOPPED")
        return message

    def transport_lost(self, close_code: int | None = None) -> None:
        """The socket closed without our ``session.close``: ``created``/``active`` → ``grace`` (§9.1; resume is
        SLC-17), or ``closed`` for the terminal close codes of §9.3 (:data:`TERMINAL_CLOSE_CODES`: 4003 forgets the
        token, 4011 means another connection took the session over)."""
        reason = TERMINAL_CLOSE_CODES.get(close_code) if close_code is not None else None
        if reason is not None and self.state not in (SessionState.IDLE, SessionState.CLOSED):
            self._close(reason)
        elif self.state in (SessionState.CREATED, SessionState.ACTIVE, SessionState.RESUMING):
            self.snapshot_in_flight = None  # the relay discards a partial snapshot (§6.3)
            self._snapshot_ids = frozenset()
            self._pending_ping_id = None
            # messages on the way may be lost: a snapshot after the resume (SLC-17 may compare versions instead)
            self._snapshot_needed = True
            self.state = SessionState.GRACE
        elif self.state is SessionState.CONNECTING:
            self._close("CONNECT_FAILED")

    def ends_session(self, message: Any) -> bool:
        """``message`` is a valid ``session.expired``/``session.closed`` for this client's session (§4.5, T11) — also
        once the client is closed, e.g. when the relay ended the session while our ``session.close`` was on its way.
        Changes nothing."""
        type_ = message.get("type") if isinstance(message, Mapping) else None
        # relay input: a list or dict is not hashable, so the type is checked before the set lookup
        if not isinstance(type_, str) or type_ not in _SESSION_END_TYPES:
            return False
        version = message.get("protocolVersion")
        match = _VERSION.fullmatch(version) if isinstance(version, str) else None
        return (
            match is not None
            and int(match.group(1)) == 1
            and _valid_session_end(message)
            and self.session_id is not None
            and message["sessionId"] == self.session_id
        )

    def _require_live(self, what: str) -> None:
        if self.state not in (SessionState.CREATED, SessionState.ACTIVE):
            raise ProtocolStateError(f"cannot {what} in state {self.state.value}")

    def _live_limits(self) -> dict[str, Any]:
        """The relay's ``session.created.limits`` — set in every state that builds scene messages."""
        if self.limits is None:
            raise ProtocolStateError(f"no relay limits in state {self.state.value}")
        return self.limits

    def _close(self, reason: str) -> None:
        self.state = SessionState.CLOSED
        self.close_reason = reason
        self._publisher_token = None
        # an ended session's code must not stay on screen or be reused as preferredCode
        self.code = None
        self.snapshot_in_flight = None
        self._snapshot_ids = frozenset()
        self._pending_ping_id = None
        # nothing can send them any more; node IDs do not outlive the session in memory
        self._held_changes.clear()
        self._held_removed.clear()
        self._snapshot_needed = False
        _log.info("session: closed (%s)", reason)

    # ------------------------------------------------------------------ inbound

    def handle(self, message: Mapping[str, Any]) -> list[dict[str, Any]]:
        """Apply one parsed inbound message; return the messages to send in reply (possibly none).

        Never raises for relay input: a message that fails the checks is ignored and counted.
        """
        if not isinstance(message, Mapping):
            return self._invalid("envelope")
        version = message.get("protocolVersion")
        match = _VERSION.fullmatch(version) if isinstance(version, str) else None
        if match is None or ("replyTo" in message and not _short_str(message["replyTo"], 32)):
            return self._invalid("envelope")
        if int(match.group(1)) != 1:  # §2: never downgrade silently; the relay closes with 4000 too
            if self.state not in (SessionState.IDLE, SessionState.CLOSED):
                self.last_error = ErrorInfo(
                    "UNSUPPORTED_VERSION", "relay speaks another protocol major", False, None
                )
                self._close("UNSUPPORTED_VERSION")
            return []
        type_ = message.get("type")
        handler = self._HANDLERS.get(type_) if isinstance(type_, str) else None
        if handler is None:
            return []  # unknown or not-for-publisher types are ignored (§2, §14; a client never sends error)
        if not _INBOUND_CHECKS[type_](message) or (
            self._validate is not None and self._validate(dict(message))
        ):
            return self._invalid(type_)
        # No session: late messages (e.g. an error crossing session.close) change nothing.
        no_session = self.state in (SessionState.IDLE, SessionState.CLOSED)
        return [] if no_session else handler(self, message)

    def _invalid(self, what: str) -> list[dict[str, Any]]:
        # `what` is "envelope" or a known message type: never relay text (log injection, T4).
        self.invalid_inbound += 1
        self.last_invalid_type = what
        _log.warning("ignored an invalid inbound %s", what)
        return []

    def _on_created(self, m: Mapping[str, Any]) -> list[dict[str, Any]]:
        if self.state is not SessionState.CONNECTING:
            return []
        if "replyTo" in m and m["replyTo"] != self._pending_create_id:
            return self._invalid("session.created")
        self.session_id = m["sessionId"]
        self.code = m["code"]
        self._publisher_token = Secret(m["publisherToken"])
        self.viewer_limit = m["viewerLimit"]
        self.ttl = dict(m["ttl"])
        self.limits = dict(m["limits"])
        self._pending_create_id = None
        self.state = SessionState.CREATED
        _log.info("session: created")
        return []

    def _on_expiring(self, m: Mapping[str, Any]) -> list[dict[str, Any]]:
        if self.auto_renew and self.state in (SessionState.CREATED, SessionState.ACTIVE):
            return [self.build_session_renew()]
        return []

    def _on_renewed(self, m: Mapping[str, Any]) -> list[dict[str, Any]]:
        self.ttl = dict(m["ttl"])
        return []

    def _on_viewer_count(self, m: Mapping[str, Any]) -> list[dict[str, Any]]:
        self.viewer_count = m["viewerCount"]
        self.viewer_limit = m["viewerLimit"]
        self.platforms = _platform_counts(m["platforms"])
        return []

    def _on_ack(self, m: Mapping[str, Any]) -> list[dict[str, Any]]:
        if m["sceneVersion"] != self.snapshot_in_flight:
            return []
        self.snapshot_in_flight = None
        self._snapshot_ids = frozenset()
        self.snapshot_version = self.accepted_version = m["sceneVersion"]
        return [] if self.updates_held else self._release_held()

    def _on_pong(self, m: Mapping[str, Any]) -> list[dict[str, Any]]:
        if m.get("replyTo") == self._pending_ping_id:
            self._pending_ping_id = None
        return []

    def _on_error(self, m: Mapping[str, Any]) -> list[dict[str, Any]]:
        code = m["code"]
        reply_to = m.get("replyTo")
        details = dict(m.get("details", {}))
        self.last_error = ErrorInfo(code, m["message"], m.get("retryable"), reply_to, details)
        _log.warning("relay error %s", code)
        if self.state is SessionState.CONNECTING:
            if reply_to is None or reply_to == self._pending_create_id:
                # session.create refused (CAPACITY, RATE_LIMITED, …); the relay closes the socket
                self._close(code)
        elif code in _FATAL_ERRORS:
            self._close(code)
        elif self.snapshot_in_flight is not None and (
            reply_to in self._snapshot_ids or (reply_to is None and code in _SNAPSHOT_REJECTIONS)
        ):
            # The relay ignores that version; the next snapshot gets a new one. Any error answering this begin/end
            # drops it; without replyTo (chunk-level errors, timeouts) only the snapshot rejections do. An error
            # answering another message leaves the in-flight snapshot alone.
            self.snapshot_in_flight = None
            self._snapshot_ids = frozenset()
            self._snapshot_needed = True
        elif self._answers_current_update(reply_to) or (
            reply_to is None and code == "BAD_SEQUENCE"
        ):
            # the relay dropped an update the viewers needed: re-sync with a snapshot (§8.1)
            self._snapshot_needed = True
        return []

    def _answers_current_update(self, reply_to: str | None) -> bool:
        match = _UPDATE_ID.fullmatch(reply_to) if reply_to is not None else None
        # sent after the current snapshot's begin, and sent at all (a relay cannot name an ID we never used)
        return match is not None and self._epoch < int(match.group(1)) <= self._next_id

    def _on_session_end(self, m: Mapping[str, Any]) -> list[dict[str, Any]]:
        if m["sessionId"] != self.session_id:
            # another session's end must not close this one (T11: clients drop sessionId mismatches)
            return self._invalid(m["type"])
        self._close(m["reason"])
        return []

    _HANDLERS: ClassVar[
        Mapping[str, Callable[[ProtocolClient, Mapping[str, Any]], list[dict[str, Any]]]]
    ] = MappingProxyType(
        {
            "session.created": _on_created,
            "session.expiring": _on_expiring,
            "session.renewed": _on_renewed,
            "viewer.count": _on_viewer_count,
            "scene.snapshot.ack": _on_ack,
            "pong": _on_pong,
            "error": _on_error,
            "session.expired": _on_session_end,
            "session.closed": _on_session_end,
        }
    )


def build_session_create(
    client_info: Mapping[str, Any],
    profile: str,
    preferred_code: str | None = None,
    *,
    message_id: str | None = None,
) -> dict[str, Any]:
    """``session.create`` (§4.1). ``preferred_code`` must be a well-formed code the publisher held before."""
    if profile not in PROFILES:
        raise ValueError(f"profile must be one of {PROFILES}")
    if preferred_code is not None and not alphabet.is_code(preferred_code):
        raise ValueError("preferredCode is not a well-formed session code")
    return envelope(
        "session.create",
        message_id,
        clientInfo=dict(client_info),
        preferredCode=preferred_code,
        profile=profile,
    )
