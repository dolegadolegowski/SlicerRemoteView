# Cross-component bug reports

A workstream that finds a bug in **another** component's code does not edit that component's plan
(`CLAUDE.md` rule 4). It files a report here instead; the owning workstream triages it at the start of
its next run (`CLAUDE.md` rule 9) and copies it into its own plan as a `todo` task.

## File name

`YYYY-MM-DD-<reporter>-<n>.md`, e.g. `2026-11-03-web-1.md` (`<reporter>` = component that found the bug,
`<n>` = running number for that day).

## Format

```markdown
# <one-line title>

- **Reported by**: <component> (`<branch>`, commit `<sha>`)
- **Affects**: <component> — <file or area>
- **Severity**: high | medium | low
- **Milestone**: M1
- **Protocol**: v1.0 (if protocol-related, cite the section of `docs/protocol.md`)
- **Status**: open | triaged (<task ID in owner's plan>) | fixed (<commit>) | rejected (<reason>)

## Steps to reproduce

1. …

## Expected

…

## Actual

…

## Notes / suspected cause

…
```

Reports never contain scene payloads, session codes or tokens (`CLAUDE.md` rule 6).
