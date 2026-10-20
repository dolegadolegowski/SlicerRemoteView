#!/usr/bin/env node
/**
 * Test helper for slicer-plugin/tests/test_glb_writer.py (SLC-04): validates GLB files written by the Python
 * writer with the Khronos glTF validator (the `gltf-validator` devDependency of `shared/`, installed by `npm ci`)
 * and with the protocol §7.1 container rules that every viewer pre-checks (same rules as
 * `snapshotRuleViolations` in shared/test/glb.test.ts).
 *
 *   node slicer-plugin/tests/validate_glb.mjs <file.glb>...   → JSON {<file>: {numErrors, numWarnings, messages, violations}}
 */
import { readFileSync } from "node:fs";
import { validateBytes } from "gltf-validator";

const ALLOWED_EXTENSIONS = ["KHR_mesh_quantization"];

function violations(glb) {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (glb.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) return ["container: bad magic"];
  if (view.getUint32(8, true) !== glb.byteLength) return ["container: length mismatch"];
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)));
  const out = [];
  if ((json.scenes ?? []).length !== 1) out.push("exactly one scene");
  if ((json.buffers ?? []).length !== 1) out.push("exactly one buffer");
  if ((json.buffers ?? []).some((b) => b.uri !== undefined)) out.push("no uri");
  for (const key of ["images", "textures", "samplers", "animations", "skins", "cameras"])
    if (Array.isArray(json[key]) && json[key].length) out.push(`no ${key}`);
  if ((json.extensionsRequired ?? []).some((x) => !ALLOWED_EXTENSIONS.includes(x)))
    out.push("extensionsRequired ⊆ {KHR_mesh_quantization}");
  const roots = json.scenes?.[0]?.nodes ?? [];
  const root = roots.length === 1 ? json.nodes?.[roots[0]] : undefined;
  if (!root || root.name !== "SlicerRemoteView" || root.extras?.nodeId !== "root")
    out.push("single root node SlicerRemoteView with extras.nodeId root");
  return out;
}

const report = {};
for (const file of process.argv.slice(2)) {
  const bytes = new Uint8Array(readFileSync(file));
  const result = await validateBytes(bytes, { writeTimestamp: false });
  report[file] = {
    numErrors: result.issues.numErrors,
    numWarnings: result.issues.numWarnings,
    messages: result.issues.messages.map((m) => `${m.code} ${m.pointer ?? ""} ${m.message}`),
    violations: violations(bytes),
  };
}
console.log(JSON.stringify(report));
