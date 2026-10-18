"""SlicerRemoteView protocol contract for Python (``docs/protocol.md`` v1.0).

Vendored into the Slicer extension as ``RemoteView/_vendor/remoteview_protocol`` (ADR 0007 §3,
``shared/scripts/vendor-py.mjs``); the schemas ship inside the package (``schema/``) so nothing
outside it is needed at runtime. Modules: ``schemas`` (validation), ``envelope`` (parse/make),
``chunk_header`` (binary GLB chunks), ``alphabet`` (session codes). Runtime dependency:
``jsonschema`` only.
"""

from remoteview_protocol.alphabet import (
    ALPHABET,
    CODE_HINTS,
    CODE_LENGTH,
    CODE_PATTERN,
    InvalidCodeError,
    is_code,
    normalize_code,
)
from remoteview_protocol.chunk_header import (
    CHUNK_HEADER_BYTES,
    CHUNK_MAGIC,
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
from remoteview_protocol.envelope import ParseError, dumps, make, parse
from remoteview_protocol.schemas import (
    LENIENT_ENUM_DEFINITIONS,
    SCHEMA_BASE,
    Issue,
    Validators,
    compile_schemas,
    load_schemas,
    message_types,
    validate_message,
)

__version__ = "0.1.0"

#: Protocol version every envelope carries (§2).
PROTOCOL_VERSION = "1.0"
#: The major version this library implements; other majors are ``UNSUPPORTED_VERSION`` (§2).
PROTOCOL_MAJOR = 1

__all__ = [
    "ALPHABET",
    "CHUNK_HEADER_BYTES",
    "CHUNK_MAGIC",
    "CODE_HINTS",
    "CODE_LENGTH",
    "CODE_PATTERN",
    "LENIENT_ENUM_DEFINITIONS",
    "MAX_CHUNK_COUNT",
    "MAX_CHUNK_SIZE",
    "MAX_SNAPSHOT_BYTES",
    "MIN_CHUNK_SIZE",
    "PROTOCOL_MAJOR",
    "PROTOCOL_VERSION",
    "SCHEMA_BASE",
    "BadSequenceError",
    "ChunkHeader",
    "DecodedChunk",
    "ExpectedChunk",
    "InvalidCodeError",
    "Issue",
    "ParseError",
    "Validators",
    "__version__",
    "check_chunk",
    "chunk_count_for",
    "chunkify",
    "compile_schemas",
    "decode_chunk_header",
    "dumps",
    "encode_chunk_frame",
    "encode_chunk_header",
    "expected_payload_length",
    "is_code",
    "load_schemas",
    "make",
    "message_types",
    "normalize_code",
    "parse",
    "sha256_hex",
    "validate_message",
]
