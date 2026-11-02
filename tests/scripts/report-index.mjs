#!/usr/bin/env node
// QA-10: report triage index.
//
// Parses every cross-component bug report in docs/testing/reports/*.md (except README.md and TRIAGE.md) and
// writes docs/testing/reports/TRIAGE.md: the open and triaged reports grouped by owner component (with severity,
// milestone and status), counts of fixed and rejected reports, and a list of reports the index could not read.
// Field format: docs/testing/reports/README.md §Format; triage flow and SLAs: the same file §Triage.
//
// Usage (Node 22, no dependencies; paths resolve from this file, so any working directory works):
//   node tests/scripts/report-index.mjs              regenerate TRIAGE.md
//   node tests/scripts/report-index.mjs --check      exit 1 if TRIAGE.md is stale, or a report has no owner
//                                                    component (Affects), no status, an unknown status word,
//                                                    or cannot be parsed
//   node tests/scripts/report-index.mjs --check --release
//                                                    also exit 1 if a report is still `open` or a `high` report
//                                                    is not fixed/rejected (00-overview.md §5 release checks)
//   --dir <path>                                     reports directory (default docs/testing/reports)
//
// Reports are written by many workstreams in slightly different styles, so the parser is tolerant: `**Field**:`,
// `**Field:**` and plain `Field:` bullets, values continued on indented lines, non-canonical status words
// ("closed", "in progress", "decided", …) mapped to the canonical ones and listed as warnings. A file it cannot
// read is listed under "Problems" instead of crashing the run. Reports never contain codes or tokens (CLAUDE.md
// rule 6); this script only echoes file names, titles and the header fields.

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKIP_FILES = new Set(["README.md", "TRIAGE.md"]);

/** Component names from the CLAUDE.md component map: the only valid owners. */
const COMPONENTS = ["protocol", "server", "web", "slicer", "quest", "deploy", "qa", "release"];
const COMPONENT_RE = new RegExp(`\\b(${COMPONENTS.join("|")})\\b`, "gi");

const SEVERITIES = ["high", "medium", "low"];

/** Canonical status words (README §Format) and the non-canonical words seen in reports, mapped to them. */
const STATUS_WORDS = [
  { re: /^open\b/i, status: "open", canonical: true },
  { re: /^triaged\b/i, status: "triaged", canonical: true },
  { re: /^fixed\b/i, status: "fixed", canonical: true },
  { re: /^rejected\b/i, status: "rejected", canonical: true },
  { re: /^(closed|done|resolved)\b/i, status: "fixed", canonical: false },
  { re: /^(in[ -]progress|wip|decided|accepted|planned)\b/i, status: "triaged", canonical: false },
  { re: /^(won'?t[ -]?fix|invalid|duplicate|not a bug)\b/i, status: "rejected", canonical: false },
];

/**
 * References kept from a status detail, in order of appearance: task IDs of the component plans (CLAUDE.md
 * component map), decision IDs (`D5`, docs/research/protocol-v1.1-decisions.md) and other reports' names.
 */
const REF_RE = /\b(?:(?:PRO|SRV|WEB|SLC|QST|DEP|QA)-\d+|D\d+|\d{4}-\d{2}-\d{2}-[a-z]+(?:-[A-Za-z0-9]+)*)\b/g;

/** Header fields the index reads; keys are lower-case labels. "owner" is accepted as an alias of "affects". */
const FIELDS = new Set(["reported by", "affects", "owner", "severity", "milestone", "status", "protocol"]);

// A header field line: optional bullet, optional bold, label, colon (inside or outside the bold), value.
// Matches `- **Status**: open`, `- **Status:** open`, `* Status: open`, `**Status**: open`.
const FIELD_LINE_RE = /^\s{0,3}(?:[-*+]\s+)?(?:\*\*|__)?([A-Za-z][A-Za-z /-]*?)(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.*)$/;

function parseArgs(argv) {
  const args = { check: false, release: false, dir: join(REPO_ROOT, "docs", "testing", "reports") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") args.check = true;
    else if (a === "--release") args.release = true;
    else if (a === "--dir") {
      const v = argv[++i];
      if (!v) usage("--dir needs a path");
      args.dir = resolve(v);
    } else if (a === "--help" || a === "-h") usage();
    else usage(`unknown argument: ${a}`);
  }
  if (args.release && !args.check) usage("--release is used together with --check");
  return args;
}

function usage(message) {
  if (message) process.stderr.write(`report-index: ${message}\n`);
  process.stderr.write("usage: node tests/scripts/report-index.mjs [--check [--release]] [--dir <reports dir>]\n");
  process.exit(message ? 2 : 0);
}

/** Splits `text` on `sep` outside parentheses and backticks. */
function splitTopLevel(text, sep) {
  const parts = [];
  let depth = 0;
  let inCode = false;
  let cur = "";
  for (const ch of text) {
    if (ch === "`") inCode = !inCode;
    else if (!inCode && (ch === "(" || ch === "[")) depth++;
    else if (!inCode && (ch === ")" || ch === "]")) depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0 && !inCode) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * Components named in an `Affects` value, owner first. The format is
 * `<component> — <area>; <component> — <area>`; a segment without a dash counts only if it starts with a
 * component name. Words inside the area text (file paths, prose) are not components.
 */
export function componentsOf(affects) {
  const found = [];
  for (const segment of splitTopLevel(affects, ";")) {
    const dash = segment.search(/\s[—–-]\s/);
    let prefix;
    if (dash >= 0) prefix = segment.slice(0, dash);
    else {
      const lead = segment.match(/^[A-Za-z]+/);
      prefix = lead && COMPONENTS.includes(lead[0].toLowerCase()) ? lead[0] : "";
    }
    for (const m of prefix.matchAll(COMPONENT_RE)) {
      const c = m[1].toLowerCase();
      if (!found.includes(c)) found.push(c);
    }
  }
  return found;
}

/** Status word, whether it is canonical, and a short detail (task IDs, else a plain-text excerpt). */
export function parseStatus(raw) {
  const text = raw.replace(/^[\s*_`]+/, "");
  const hit = STATUS_WORDS.find((w) => w.re.test(text));
  if (!hit) return null;
  const word = text.match(hit.re)[0];
  const rest = text.slice(word.length);
  const ids = [...new Set(rest.match(REF_RE) ?? [])];
  let detail = "";
  if (ids.length > 0) detail = ids.slice(0, 4).join(", ") + (ids.length > 4 ? ", …" : "");
  else {
    const plain = rest.replace(/[`*_]/g, "").replace(/^[\s:(—–-]+/, "").replace(/\).*$/, "").trim();
    if (plain) detail = plain.length > 48 ? `${plain.slice(0, 47).trimEnd()}…` : plain;
  }
  return { status: hit.status, word: word.toLowerCase(), canonical: hit.canonical, detail };
}

/** Parses one report. Returns `{ ok: true, report }` or `{ ok: false, reason }`; never throws on content. */
export function parseReport(file, text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const titleLine = lines.find((l) => /^#\s+\S/.test(l));
  if (!titleLine) return { ok: false, reason: "no `# title` line" };
  const title = titleLine.replace(/^#\s+/, "").trim();

  // Header block: from the title to the first `## ` heading. If it holds no field, scan the whole file.
  const start = lines.indexOf(titleLine) + 1;
  let end = lines.findIndex((l, i) => i >= start && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  let fields = readFields(lines.slice(start, end));
  if (fields.size === 0) fields = readFields(lines);
  if (fields.size === 0) return { ok: false, reason: "no header fields (`- **Field**: value` bullets)" };

  const affects = fields.get("affects") ?? fields.get("owner") ?? "";
  const statusRaw = fields.get("status") ?? "";
  const severityRaw = fields.get("severity") ?? "";
  const severity = (severityRaw.match(/\b(high|medium|low)\b/i)?.[1] ?? "").toLowerCase();
  const milestones = [...new Set(fields.get("milestone")?.match(/\bM\d+[a-z]?\b/g) ?? [])];
  const reporter = (fields.get("reported by") ?? "").match(/^[\s`*]*([A-Za-z]+)/)?.[1]?.toLowerCase() ?? "";
  const components = componentsOf(affects);

  return {
    ok: true,
    report: {
      file,
      title,
      filed: file.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? "",
      reporter,
      owner: components[0] ?? "",
      alsoAffects: components.slice(1),
      hasAffects: affects.trim().length > 0,
      severity,
      milestones,
      statusRaw,
      status: statusRaw ? parseStatus(statusRaw) : null,
    },
  };
}

/** Header fields of `lines`: the first occurrence of each known label, with indented continuation lines. */
function readFields(lines) {
  const fields = new Map();
  let current = null;
  for (const line of lines) {
    const m = line.match(FIELD_LINE_RE);
    const label = m?.[1].trim().toLowerCase();
    if (m && label && FIELDS.has(label)) {
      current = fields.has(label) ? null : label;
      if (current) fields.set(current, m[2].trim());
    } else if (current && /^\s+\S/.test(line) && !/^\s{0,3}[-*+]\s/.test(line)) {
      fields.set(current, `${fields.get(current)} ${line.trim()}`);
    } else current = null;
  }
  return fields;
}

/** Escapes text for a Markdown table cell. */
function cell(text) {
  return String(text).replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function link(file) {
  return `[${file.replace(/\.md$/, "")}](${file})`;
}

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2, "": 3 };
const STATUS_ORDER = { open: 0, triaged: 1 };

/** Builds the TRIAGE.md text and the list of problems. Deterministic: no clock, sorted input. */
export function buildIndex(entries) {
  const reports = entries.filter((e) => e.ok).map((e) => e.report);
  const unparseable = entries.filter((e) => !e.ok);
  const problems = []; // { file, problem, fatal }

  for (const e of unparseable) problems.push({ file: e.file, problem: `unparseable: ${e.reason}`, fatal: true });
  for (const r of reports) {
    if (!r.hasAffects) problems.push({ file: r.file, problem: "no `Affects` field (owner component)", fatal: true });
    else if (!r.owner)
      problems.push({
        file: r.file,
        problem: `\`Affects\` names no component (${COMPONENTS.join(", ")}) before its "—"`,
        fatal: true,
      });
    if (!r.statusRaw) problems.push({ file: r.file, problem: "no `Status` field", fatal: true });
    else if (!r.status) problems.push({ file: r.file, problem: "unknown status word", fatal: true });
    else if (!r.status.canonical)
      problems.push({
        file: r.file,
        problem: `non-canonical status "${r.status.word}" read as \`${r.status.status}\``,
        fatal: false,
      });
    if (!r.severity) problems.push({ file: r.file, problem: "no severity high/medium/low", fatal: false });
  }

  const active = reports.filter((r) => r.status && (r.status.status === "open" || r.status.status === "triaged"));
  const closed = reports.filter((r) => r.status && (r.status.status === "fixed" || r.status.status === "rejected"));
  const count = (list, pred) => list.filter(pred).length;

  const out = [];
  out.push("# Report triage index");
  out.push("");
  out.push("Generated by `node tests/scripts/report-index.mjs` from the reports in this directory — **do not edit by");
  out.push("hand**; regenerate after adding a report or changing a `Status`. `--check` (for CI) fails on a stale index,");
  out.push("a report without an owner component or a status. Triage flow, status transitions and SLAs:");
  out.push("[README.md](README.md#triage). Owner = the first component named in `Affects`.");
  out.push("");
  out.push("## Summary");
  out.push("");
  out.push("| Status | high | medium | low | no severity | Total |");
  out.push("|---|---|---|---|---|---|");
  for (const s of ["open", "triaged", "fixed", "rejected"]) {
    const list = reports.filter((r) => r.status?.status === s);
    out.push(
      `| ${s} | ${SEVERITIES.map((v) => count(list, (r) => r.severity === v)).join(" | ")} | ` +
        `${count(list, (r) => !r.severity)} | ${list.length} |`,
    );
  }
  // Reports without a readable status are fatal problems (listed below); a row keeps the totals adding up.
  const unknown = reports.filter((r) => !r.status);
  if (unknown.length > 0)
    out.push(
      `| no or unknown status | ${SEVERITIES.map((v) => count(unknown, (r) => r.severity === v)).join(" | ")} | ` +
        `${count(unknown, (r) => !r.severity)} | ${unknown.length} |`,
    );
  out.push(`| **all reports** | ${SEVERITIES.map((v) => count(reports, (r) => r.severity === v)).join(" | ")} | ` +
    `${count(reports, (r) => !r.severity)} | ${reports.length} |`);
  out.push("");
  if (unparseable.length > 0) out.push(`Unparseable files (not counted above): ${unparseable.length}.`, "");

  out.push("## Open and triaged reports by owner component");
  out.push("");
  const owners = [...new Set(active.map((r) => r.owner || "(no owner)"))].sort(
    (a, b) => ownerRank(a) - ownerRank(b) || a.localeCompare(b),
  );
  if (owners.length === 0) out.push("None.", "");
  for (const owner of owners) {
    const list = active
      .filter((r) => (r.owner || "(no owner)") === owner)
      .sort(
        (a, b) =>
          SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
          STATUS_ORDER[a.status.status] - STATUS_ORDER[b.status.status] ||
          a.file.localeCompare(b.file),
      );
    const open = count(list, (r) => r.status.status === "open");
    out.push(`### ${owner} — ${list.length} (${open} open, ${list.length - open} triaged)`);
    out.push("");
    out.push("| Report | Severity | Milestone | Status | Also affects | Title |");
    out.push("|---|---|---|---|---|---|");
    for (const r of list) {
      const st = r.status.detail ? `${r.status.status} (${r.status.detail})` : r.status.status;
      out.push(
        `| ${link(r.file)} | ${r.severity || "—"} | ${r.milestones.join(", ") || "—"} | ${cell(st)} | ` +
          `${r.alsoAffects.join(", ") || "—"} | ${cell(r.title)} |`,
      );
    }
    out.push("");
  }

  out.push("## Fixed and rejected (counts)");
  out.push("");
  const closedOwners = [...new Set(closed.map((r) => r.owner || "(no owner)"))].sort(
    (a, b) => ownerRank(a) - ownerRank(b) || a.localeCompare(b),
  );
  if (closedOwners.length === 0) out.push("None.", "");
  else {
    out.push("| Owner | fixed | rejected | Reports |");
    out.push("|---|---|---|---|");
    for (const owner of closedOwners) {
      const list = closed.filter((r) => (r.owner || "(no owner)") === owner).sort((a, b) => a.file.localeCompare(b.file));
      out.push(
        `| ${owner} | ${count(list, (r) => r.status.status === "fixed")} | ` +
          `${count(list, (r) => r.status.status === "rejected")} | ${list.map((r) => link(r.file)).join(", ")} |`,
      );
    }
    out.push("");
  }

  out.push("## Problems");
  out.push("");
  out.push("Fatal problems (`--check` fails) are a missing owner component, a missing or unknown status, or a file");
  out.push("that cannot be parsed. Warnings are listed so the owner can normalise the report at its next triage.");
  out.push("");
  if (problems.length === 0) out.push("None.");
  else {
    out.push("| Report | Kind | Problem |");
    out.push("|---|---|---|");
    for (const p of [...problems].sort((a, b) => Number(b.fatal) - Number(a.fatal) || a.file.localeCompare(b.file))) {
      out.push(`| ${link(p.file)} | ${p.fatal ? "**fatal**" : "warning"} | ${cell(p.problem)} |`);
    }
  }
  out.push("");
  return { text: out.join("\n"), problems, reports };
}

function ownerRank(owner) {
  const i = COMPONENTS.indexOf(owner);
  return i < 0 ? COMPONENTS.length : i;
}

function readReports(dir) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".md") && !SKIP_FILES.has(f))
    .sort();
  return files.map((file) => {
    try {
      return { file, ...parseReport(file, readFileSync(join(dir, file), "utf8")) };
    } catch (err) {
      return { file, ok: false, reason: `read error (${err instanceof Error ? err.code ?? err.message : "?"})` };
    }
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.dir)) usage(`no reports directory: ${args.dir}`);
  const entries = readReports(args.dir);
  const { text, problems, reports } = buildIndex(entries);
  const target = join(args.dir, "TRIAGE.md");

  if (!args.check) {
    writeFileSync(target, text);
    const fatal = problems.filter((p) => p.fatal).length;
    process.stdout.write(
      `report-index: wrote TRIAGE.md (${reports.length} reports, ${entries.length - reports.length} unparseable, ` +
        `${fatal} fatal problem(s), ${problems.length - fatal} warning(s))\n`,
    );
    return;
  }

  const failures = [];
  const current = existsSync(target) ? readFileSync(target, "utf8").replace(/\r\n?/g, "\n") : null;
  if (current === null) failures.push("TRIAGE.md is missing: run `node tests/scripts/report-index.mjs`");
  else if (current !== text) failures.push("TRIAGE.md is stale: run `node tests/scripts/report-index.mjs` and commit it");
  for (const p of problems.filter((x) => x.fatal)) failures.push(`${p.file}: ${p.problem}`);
  if (args.release) {
    for (const r of reports) {
      if (r.status?.status === "open") failures.push(`${r.file}: still open (release checks: triage it)`);
      if (r.severity === "high" && r.status && r.status.status !== "fixed" && r.status.status !== "rejected")
        failures.push(`${r.file}: high severity and not fixed/rejected`);
    }
  }
  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`report-index --check: ${f}\n`);
    process.exit(1);
  }
  process.stdout.write(`report-index --check: OK (${reports.length} reports)\n`);
}

// Run only when executed directly, so the parser can be imported by a test.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
