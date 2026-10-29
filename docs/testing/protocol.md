# Testing — `protocol` (environment-dependent checks)

Everything the `protocol` workstream builds runs in the sandbox (`npm test`, `npm run check -w shared`, pytest) except
the C# compile check of PRO-17, which needs a .NET SDK; this file covers that check (other sections get added when needed).

## 1. C# generated types (PRO-17)

Generated files: `shared/cs/RemoteView.Protocol/{Messages,MessageTypes}.cs` (`npm run generate -w shared`).
Offline checks that always run (`npm test -w shared`, `npm run check -w shared`): generation is deterministic, the
committed files equal a fresh generation, the drift check fails on a modified, missing or extra file, the shape
(one class per message type, `[JsonProperty]` camelCase, enums with `Other`, no `record`/`init`) — `shared/test/cs.test.ts`.

### 1.1 Compile and conformance on a machine with the .NET SDK (CI, plan criterion 1)

Prerequisites: .NET SDK 6+ (`dotnet --version`), network for the NuGet restore of `Newtonsoft.Json` 13.0.2 and the
`netstandard2.1` targeting pack.

```bash
npm ci
npm run check:cs -w shared -- --require-dotnet
```

Expected output (counts grow with the fixtures):

```
build-cs: RemoteView.Protocol compiles (netstandard2.1, LangVersion 9.0, SDK <version>)
C# conformance: 61 valid fixtures, 161 checks, 0 failure(s)
```

What it does: builds `shared/cs/RemoteView.Protocol/*.cs` in a throwaway `netstandard2.1` library in the OS temp
directory (nothing is written into the repository), then runs `shared/scripts/cs-conformance/Program.cs` — every
`valid-*.json` fixture is deserialised into the class named by `MessageTypes.Classes` with
`MissingMemberHandling.Error` and serialised back to equal JSON; unknown enum values map to `Other`; `Type` defaults are
set; optional nulls are omitted. `shared/test/cs.test.ts` runs the same thing when `RUN_DOTNET_TESTS=1`.
A DEP-01 CI job should call the command above on a runner that has `dotnet` (GitHub's `ubuntu-latest` does).

### 1.2 Offline variant (no NuGet access)

If a .NET SDK exists but the NuGet feed is unreachable, reference a local `Newtonsoft.Json.dll` and a target framework
whose reference pack ships with the SDK:

```bash
node shared/scripts/build-cs.mjs --dotnet <path-to>/dotnet --framework net10.0 --newtonsoft-dll <path-to>/Newtonsoft.Json.dll
```

This proves the C# ≤ 9 sources compile and behave, but not the `netstandard2.1` target.

### 1.3 Unity (QST-03, `docs/testing/quest.md` §2)

After QST-03 copies the files into `quest-app/Assets/RemoteView/Protocol/Generated/`: open the project, confirm the
assembly compiles with `com.unity.nuget.newtonsoft-json` 3.2.1 and an IL2CPP Android build deserialises one message of
each kind (needs `link.xml` preserving `Newtonsoft.Json` and the protocol assembly, `docs/research/quest.md` §6).

### 1.4 What has been verified so far

| Check | Where | Result |
|---|---|---|
| Generation deterministic, committed files fresh, drift check, shape, enum `Other`, mutation checks | sandbox, vitest (`test/cs.test.ts`) | passes (2026-10-27); mutated generator (fallback removed, drift comparison disabled) makes the tests fail |
| Compile with LangVersion 9.0 against Newtonsoft.Json 13.0.3 on **net10.0**, offline | .NET SDK 10.0.302 (project-local, not on PATH) via `--dotnet`, `--framework net10.0`, `--newtonsoft-dll` | passes (2026-10-27): 61 valid fixtures, 161 checks, 0 failures; a deliberately broken property name and a removed `Other` fallback make the run fail |
| Compile on **netstandard2.1** with NuGet `Newtonsoft.Json` 13.0.2 | needs a runner with `dotnet` and NuGet access | **not verified** — the `netstandard2.1` reference pack is not part of the SDK and was not downloaded in the sandbox |
| Unity 6 / 2022 LTS, IL2CPP, Meta XR | needs Unity | **not verified** — QST-03 |
