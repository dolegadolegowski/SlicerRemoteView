# Binary test vectors — chunk header (`docs/protocol.md` §6.3)

Produced by `encodeChunkHeader` in `shared/ts/chunk.ts` (PRO-07) and checked byte for byte by
`shared/test/chunk.test.ts`. Python (`shared/py`, PRO-10) and C# (`shared/cs`, PRO-17) decode the same files
to the values in `chunk-headers.json` and re-encode them identically.

| File | Bytes (hex) | Meaning |
|---|---|---|
| `chunk-header-v1-i0.bin` | `53525643 01000000 00000000` | `SRVC`, sceneVersion 1, chunkIndex 0 — first chunk of the first snapshot |
| `chunk-header-v43-i17.bin` | `53525643 2b000000 11000000` | sceneVersion 43, chunkIndex 17 (the §6.2 example's last chunk) |
| `chunk-header-v258-i1023.bin` | `53525643 02010000 ff030000` | multi-byte little-endian values; the highest legal chunkIndex |
| `chunk-header-vmax-i0.bin` | `53525643 ffffffff 00000000` | sceneVersion = uint32 max |
| `chunk-header-bad-magic.bin` | `53525658 …` | magic `SRVX` → `BAD_SEQUENCE`, field `magic` |
| `chunk-header-index-over.bin` | `… 00040000` | chunkIndex 1024 → `BAD_SEQUENCE`, field `chunkIndex` (§3.3: ≤ 1024 chunks) |
| `chunk-header-short.bin` | 11 bytes | truncated header → `BAD_SEQUENCE`, field `length` |
| `chunk-frame-v43-i2-5bytes.bin` | header + `0001020304` | a complete frame: header followed by a 5-byte payload |

`chunk-headers.json` is the machine-readable table (valid headers, invalid files with the expected field, the
frame, `chunkify` size cases and SHA-256 vectors). `../codes/normalize-cases.json` holds the `normalizeCode`
cases of ADR 0008 §7.

Header layout (little-endian): offset 0 magic `SRVC`, offset 4 `sceneVersion` uint32, offset 8 `chunkIndex`
uint32, then the payload (`chunkSize` bytes except for the last chunk).
