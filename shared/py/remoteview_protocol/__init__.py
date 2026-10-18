"""SlicerRemoteView protocol contract for Python (``docs/protocol.md`` v1.0).

Vendored into the Slicer extension as ``RemoteView/_vendor/remoteview_protocol`` (ADR 0007 §3);
the schemas ship inside the package (``schema/``) so nothing outside it is needed at runtime.
Runtime dependency: ``jsonschema`` only.
"""

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
    "LENIENT_ENUM_DEFINITIONS",
    "PROTOCOL_MAJOR",
    "PROTOCOL_VERSION",
    "SCHEMA_BASE",
    "Issue",
    "Validators",
    "__version__",
    "compile_schemas",
    "load_schemas",
    "message_types",
    "validate_message",
]
