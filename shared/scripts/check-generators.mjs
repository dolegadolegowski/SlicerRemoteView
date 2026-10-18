// PRO-02 generator spike (ADR 0002 errata): do quicktype and NJsonSchema consume `definitions`, `oneOf`, `const`?
// Usage: node shared/scripts/check-generators.mjs — runs over every shared/schema/*.schema.json; the NJsonSchema step needs `nswag` (.NET) on PATH.
import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
const dir = fileURLToPath(new URL("../schema/", import.meta.url));
const srcs = readdirSync(dir).filter((f) => f.endsWith(".schema.json")).map((f) => `--src "${dir}${f}"`).join(" ");
const run = (cmd) => console.log(execSync(cmd, { stdio: ["ignore", "pipe", "inherit"] }).toString().trim());
for (const lang of ["cs", "ts"]) run(`npx --yes quicktype@26 --src-lang schema --lang ${lang} --top-level Envelope ${srcs}`);
try { run(`nswag jsonschema2csclient /input:"${dir}envelope.schema.json" /output:/dev/stdout`); } catch { console.log("nswag (NJsonSchema CLI) not on PATH — see shared/README.md spike notes"); }
