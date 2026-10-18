"""Binary chunk helpers for GLB snapshots (``docs/protocol.md`` §6.2-6.3); mirror of ``chunk.ts``.

Every binary WebSocket frame is a 12-byte little-endian header followed by the payload:
``SRVC`` magic, ``sceneVersion`` uint32, ``chunkIndex`` uint32. Receiver-rule violations raise
:class:`BadSequenceError` (the ``error`` ``BAD_SEQUENCE`` of §9.2 with ``details.field``); publisher
misuse (sizes outside the protocol range) raises :class:`ValueError`, like ``RangeError`` in TS.
"""

from __future__ import annotations

import hashlib
import struct
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Literal

#: ASCII ``SRVC`` (§6.3).
CHUNK_MAGIC = b"SRVC"
CHUNK_HEADER_BYTES = 12
#: Smallest ``chunkSize`` a publisher may announce: 64 KiB (§6.2).
MIN_CHUNK_SIZE = 65_536
#: Largest chunk payload, and the recommended ``chunkSize``: 1 MiB (§3.3, §6.2).
MAX_CHUNK_SIZE = 1_048_576
#: Hard cap on one snapshot: 64 MiB (§3.3).
MAX_SNAPSHOT_BYTES = 67_108_864
#: ``chunkCount <= 1024`` (§3.3), so ``chunkIndex`` is ``0..1023``.
MAX_CHUNK_COUNT = 1_024
_UINT32_MAX = 0xFFFF_FFFF
_HEADER = struct.Struct("<4sII")

#: Which part of a frame broke a §6.3 rule; same vocabulary as TS and C# (``error.details.field``).
ChunkHeaderField = Literal["length", "magic", "sceneVersion", "chunkIndex", "payload"]


class BadSequenceError(ValueError):
    """A §6.3 receiver rule was violated: reply ``error BAD_SEQUENCE`` with ``details.field``."""

    code = "BAD_SEQUENCE"

    def __init__(self, field: ChunkHeaderField, message: str) -> None:
        super().__init__(message)
        self.field: ChunkHeaderField = field
        self.message = message


@dataclass(frozen=True, slots=True)
class ChunkHeader:
    """``sceneVersion`` as in ``scene.snapshot.begin`` (§6.2); ``chunkIndex`` in 0..chunkCount-1."""

    scene_version: int
    chunk_index: int


@dataclass(frozen=True, slots=True)
class DecodedChunk:
    scene_version: int
    chunk_index: int
    #: A view into the frame, not a copy.
    payload: memoryview


@dataclass(frozen=True, slots=True)
class ExpectedChunk:
    """What a receiver knows from ``scene.snapshot.begin`` plus the index it expects next (§6.3)."""

    scene_version: int
    byte_length: int
    chunk_size: int
    chunk_count: int
    #: ``0`` for the first chunk, then the previous ``chunk_index + 1``.
    next_index: int


def _check_uint32(name: str, value: int, maximum: int = _UINT32_MAX) -> None:
    if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= maximum:
        msg = f"{name} must be an integer in 0..{maximum}, got {value!r}"
        raise ValueError(msg)


def encode_chunk_header(header: ChunkHeader) -> bytes:
    """The 12-byte header of §6.3. Raises ``ValueError`` on values outside the protocol range."""
    _check_uint32("sceneVersion", header.scene_version)
    _check_uint32("chunkIndex", header.chunk_index, MAX_CHUNK_COUNT - 1)
    return _HEADER.pack(CHUNK_MAGIC, header.scene_version, header.chunk_index)


def decode_chunk_header(frame: bytes | bytearray | memoryview) -> DecodedChunk:
    """Parse a binary frame; only frame-local rules are checked (length, magic, index range).

    Session-level rules (known ``sceneVersion``, order, payload size) are :func:`check_chunk`.
    """
    view = memoryview(frame)
    if view.nbytes < CHUNK_HEADER_BYTES:
        raise BadSequenceError(
            "length",
            f"binary frame of {view.nbytes} bytes is shorter than "
            f"the {CHUNK_HEADER_BYTES}-byte header",
        )
    magic, scene_version, chunk_index = _HEADER.unpack_from(view, 0)
    if magic != CHUNK_MAGIC:
        raise BadSequenceError("magic", f"chunk magic is not {CHUNK_MAGIC.decode('ascii')}")
    if chunk_index >= MAX_CHUNK_COUNT:
        raise BadSequenceError(
            "chunkIndex", f"chunkIndex {chunk_index} exceeds the maximum of {MAX_CHUNK_COUNT - 1}"
        )
    return DecodedChunk(scene_version, chunk_index, view[CHUNK_HEADER_BYTES:])


def chunk_count_for(byte_length: int, chunk_size: int) -> int:
    """Number of chunks for a snapshot: ``ceil(byteLength / chunkSize)`` (§6.2)."""
    return -(-byte_length // chunk_size)


def expected_payload_length(chunk_index: int, byte_length: int, chunk_size: int) -> int:
    """Payload bytes chunk ``chunk_index`` must carry: ``chunk_size``, less for the last chunk."""
    return min((chunk_index + 1) * chunk_size, byte_length) - chunk_index * chunk_size


def check_chunk(chunk: DecodedChunk, expected: ExpectedChunk) -> int:
    """Apply the §6.3 receiver rules; return the byte offset to copy the payload to.

    Unknown ``sceneVersion``, out-of-order or duplicate ``chunkIndex``, index beyond ``chunkCount``
    or a payload of the wrong size raise :class:`BadSequenceError` naming the field; the caller
    discards the snapshot.
    """
    if chunk.scene_version != expected.scene_version:
        raise BadSequenceError(
            "sceneVersion",
            f"chunk for sceneVersion {chunk.scene_version}, expected {expected.scene_version}",
        )
    if chunk.chunk_index != expected.next_index:
        raise BadSequenceError(
            "chunkIndex",
            f"chunkIndex {chunk.chunk_index} out of order, expected {expected.next_index}",
        )
    if chunk.chunk_index >= expected.chunk_count:
        raise BadSequenceError(
            "chunkIndex",
            f"chunkIndex {chunk.chunk_index} beyond chunkCount {expected.chunk_count}",
        )
    want = expected_payload_length(chunk.chunk_index, expected.byte_length, expected.chunk_size)
    if chunk.payload.nbytes != want:
        raise BadSequenceError(
            "payload",
            f"chunk {chunk.chunk_index} carries {chunk.payload.nbytes} bytes, expected {want}",
        )
    return chunk.chunk_index * expected.chunk_size


def chunkify(
    glb: bytes | bytearray | memoryview, chunk_size: int = MAX_CHUNK_SIZE
) -> Iterator[tuple[int, memoryview]]:
    """Yield ``(chunk_index, payload_view)`` for ``ceil(len / chunk_size)`` chunks in order (§6.2).

    Raises ``ValueError`` when ``chunk_size`` is outside 64 KiB..1 MiB or the result would exceed
    1024 chunks or 64 MiB — the cases in which the relay rejects ``scene.snapshot.begin``.
    """
    if (
        not isinstance(chunk_size, int)
        or isinstance(chunk_size, bool)
        or not MIN_CHUNK_SIZE <= chunk_size <= MAX_CHUNK_SIZE
    ):
        msg = f"chunkSize must be {MIN_CHUNK_SIZE}..{MAX_CHUNK_SIZE}, got {chunk_size!r}"
        raise ValueError(msg)
    view = memoryview(glb)
    if not 1 <= view.nbytes <= MAX_SNAPSHOT_BYTES:
        msg = f"snapshot must be 1..{MAX_SNAPSHOT_BYTES} bytes, got {view.nbytes}"
        raise ValueError(msg)
    count = chunk_count_for(view.nbytes, chunk_size)
    if count > MAX_CHUNK_COUNT:
        msg = f"{count} chunks exceed the maximum of {MAX_CHUNK_COUNT}"
        raise ValueError(msg)
    for chunk_index in range(count):
        yield chunk_index, view[chunk_index * chunk_size : (chunk_index + 1) * chunk_size]


def encode_chunk_frame(header: ChunkHeader, payload: bytes | bytearray | memoryview) -> bytes:
    """One complete binary frame: header + payload (what a publisher sends, §6.1)."""
    return encode_chunk_header(header) + bytes(payload)


def sha256_hex(data: bytes | bytearray | memoryview) -> str:
    """SHA-256 as 64 lowercase hex characters (the ``sha256`` def, §6.4)."""
    return hashlib.sha256(data).hexdigest()
