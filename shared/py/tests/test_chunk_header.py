"""PRO-10: the Python chunk helpers decode/encode the TS vectors in ``shared/fixtures/blob``."""

from __future__ import annotations

from typing import Any

import pytest

from remoteview_protocol.chunk_header import (
    CHUNK_HEADER_BYTES,
    MAX_CHUNK_COUNT,
    MAX_CHUNK_SIZE,
    MAX_SNAPSHOT_BYTES,
    MIN_CHUNK_SIZE,
    BadSequenceError,
    ChunkHeader,
    DecodedChunk,
    ExpectedChunk,
    check_chunk,
    chunk_count_for,
    chunkify,
    decode_chunk_header,
    encode_chunk_frame,
    encode_chunk_header,
    expected_payload_length,
    sha256_hex,
)

from .conftest import FIXTURES_DIR, read_json

BLOB_DIR = FIXTURES_DIR / "blob"
VECTORS: dict[str, Any] = read_json(BLOB_DIR / "chunk-headers.json")


def test_vector_table_constants() -> None:
    assert VECTORS["headerBytes"] == CHUNK_HEADER_BYTES == 12
    assert VECTORS["magic"] == "SRVC"


@pytest.mark.parametrize("case", VECTORS["valid"], ids=lambda c: c["file"])
def test_valid_headers_decode_to_the_ts_values_and_re_encode_identically(
    case: dict[str, Any],
) -> None:
    raw = (BLOB_DIR / case["file"]).read_bytes()
    decoded = decode_chunk_header(raw)
    assert (decoded.scene_version, decoded.chunk_index) == (
        case["sceneVersion"],
        case["chunkIndex"],
    )
    assert decoded.payload.nbytes == 0
    assert encode_chunk_header(ChunkHeader(case["sceneVersion"], case["chunkIndex"])) == raw


@pytest.mark.parametrize("case", VECTORS["invalid"], ids=lambda c: c["file"])
def test_invalid_headers_raise_bad_sequence_naming_the_field(case: dict[str, Any]) -> None:
    with pytest.raises(BadSequenceError) as info:
        decode_chunk_header((BLOB_DIR / case["file"]).read_bytes())
    assert info.value.field == case["field"]
    assert info.value.code == "BAD_SEQUENCE"


@pytest.mark.parametrize("case", VECTORS["frames"], ids=lambda c: c["file"])
def test_frames_round_trip(case: dict[str, Any]) -> None:
    raw = (BLOB_DIR / case["file"]).read_bytes()
    decoded = decode_chunk_header(raw)
    assert decoded.scene_version == case["sceneVersion"]
    assert decoded.chunk_index == case["chunkIndex"]
    assert decoded.payload.hex() == case["payloadHex"]
    header = ChunkHeader(case["sceneVersion"], case["chunkIndex"])
    assert encode_chunk_frame(header, bytes.fromhex(case["payloadHex"])) == raw


@pytest.mark.parametrize(
    "case", VECTORS["chunkify"], ids=lambda c: f"{c['byteLength']}@{c['chunkSize']}"
)
def test_chunkify_cases(case: dict[str, Any]) -> None:
    glb = bytes(case["byteLength"])
    chunks = list(chunkify(glb, case["chunkSize"]))
    assert (
        len(chunks) == case["chunkCount"] == chunk_count_for(case["byteLength"], case["chunkSize"])
    )
    assert [i for i, _ in chunks] == list(range(case["chunkCount"]))
    assert all(p.nbytes == case["chunkSize"] for _, p in chunks[:-1])
    assert chunks[-1][1].nbytes == case["lastPayloadLength"]
    assert (
        expected_payload_length(case["chunkCount"] - 1, case["byteLength"], case["chunkSize"])
        == case["lastPayloadLength"]
    )


@pytest.mark.parametrize("case", VECTORS["sha256"], ids=lambda c: c["inputHex"] or "empty")
def test_sha256_vectors(case: dict[str, Any]) -> None:
    assert sha256_hex(bytes.fromhex(case["inputHex"])) == case["hex"]


def test_encode_rejects_values_outside_the_protocol_range() -> None:
    with pytest.raises(ValueError, match="chunkIndex"):
        encode_chunk_header(ChunkHeader(1, MAX_CHUNK_COUNT))
    with pytest.raises(ValueError, match="sceneVersion"):
        encode_chunk_header(ChunkHeader(-1, 0))
    with pytest.raises(ValueError, match="sceneVersion"):
        encode_chunk_header(ChunkHeader(2**32, 0))


def test_chunkify_rejects_sizes_the_relay_would_reject() -> None:
    with pytest.raises(ValueError, match="chunkSize"):
        list(chunkify(b"x", MIN_CHUNK_SIZE - 1))
    with pytest.raises(ValueError, match="chunkSize"):
        list(chunkify(b"x", MAX_CHUNK_SIZE + 1))
    with pytest.raises(ValueError, match="snapshot"):
        list(chunkify(b""))
    with pytest.raises(ValueError, match="snapshot"):
        list(chunkify(bytes(MAX_SNAPSHOT_BYTES + 1), MIN_CHUNK_SIZE))
    # 64 MiB at 64 KiB is exactly 1024 chunks, so the chunk-count cap can only trip after the
    # snapshot cap; the check stays as a guard against the two constants drifting apart.
    assert MAX_SNAPSHOT_BYTES == MAX_CHUNK_COUNT * MIN_CHUNK_SIZE
    assert len(list(chunkify(bytes(MAX_SNAPSHOT_BYTES), MIN_CHUNK_SIZE))) == MAX_CHUNK_COUNT


def test_check_chunk_applies_the_receiver_rules_of_6_3() -> None:
    expected = ExpectedChunk(
        scene_version=43,
        byte_length=2_621_440,
        chunk_size=MAX_CHUNK_SIZE,
        chunk_count=3,
        next_index=2,
    )
    ok = DecodedChunk(43, 2, memoryview(bytes(524_288)))
    assert check_chunk(ok, expected) == 2 * MAX_CHUNK_SIZE
    cases: list[tuple[DecodedChunk, str]] = [
        (DecodedChunk(42, 2, memoryview(bytes(524_288))), "sceneVersion"),
        (DecodedChunk(43, 1, memoryview(bytes(MAX_CHUNK_SIZE))), "chunkIndex"),
        (DecodedChunk(43, 2, memoryview(bytes(524_287))), "payload"),
    ]
    for chunk, field in cases:
        with pytest.raises(BadSequenceError) as info:
            check_chunk(chunk, expected)
        assert info.value.field == field
    beyond = ExpectedChunk(43, 2_621_440, MAX_CHUNK_SIZE, 3, next_index=3)
    with pytest.raises(BadSequenceError) as info:
        check_chunk(DecodedChunk(43, 3, memoryview(b"")), beyond)
    assert info.value.field == "chunkIndex"
