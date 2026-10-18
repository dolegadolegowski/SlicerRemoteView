/**
 * Extracts the machine-checkable tables of `docs/protocol.md` (§9.2 error codes, §11 permissions matrix),
 * shared by `scripts/check.mjs` (PRO-12). `test/lib.test.ts` has its own copy of the §11 parser on purpose:
 * it is the independent oracle for `PERMISSIONS`, this one only decides which types need a schema.
 */

/** Text from the heading `from` up to the heading `to`. */
export function section(doc, from, to) {
  const start = doc.indexOf(from);
  if (start < 0) throw new Error(`docs/protocol.md has no section "${from}"`);
  const end = doc.indexOf(to, start + from.length);
  return doc.slice(start, end < 0 ? undefined : end);
}

/** The `code` column of the §9.2 table, in document order. */
export function errorCodesFromDoc(doc) {
  const text = section(doc, "### 9.2 `error` message", "### 9.3");
  return [...text.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]);
}

/**
 * Message types of the §11 table. `scene.snapshot.begin/end/abort` expands to three types; the binary
 * row is skipped; rows whose publisher column says `reserved` (v1.1) are returned separately.
 * @returns {{ types: string[], reserved: string[] }}
 */
export function messageTypesFromDoc(doc) {
  const rows = section(doc, "## 11. Permissions matrix", "## 12.")
    .split("\n")
    .filter((line) => line.startsWith("| `"));
  const types = [];
  const reserved = [];
  for (const row of rows) {
    const cells = row
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    const names = [...cells[0].matchAll(/`([^`]+)`/g)].flatMap(([, name]) => {
      const slash = /^(.*\.)([^.]+(?:\/[^.]+)+)$/.exec(name);
      return slash ? slash[2].split("/").map((v) => slash[1] + v) : [name];
    });
    (cells[1] === "reserved" ? reserved : types).push(...names);
  }
  return { types: [...new Set(types)].sort(), reserved: [...new Set(reserved)].sort() };
}
