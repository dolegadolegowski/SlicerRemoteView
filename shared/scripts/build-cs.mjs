#!/usr/bin/env node
/**
 * Compile and conformance check of the generated C# (PRO-17 acceptance criterion 1): `npm run check:cs -w shared`.
 *
 * Builds `shared/cs/RemoteView.Protocol/*.cs` in a **throwaway** `netstandard2.1` class library (LangVersion 9.0 = Unity
 * LTS, Newtonsoft.Json 13.0.2 = `com.unity.nuget.newtonsoft-json` 3.2.1), then runs `scripts/cs-conformance/Program.cs`
 * against `fixtures/messages` (every valid fixture deserialises into its class and round-trips). Nothing is written
 * into the repository; the temporary project lives in the OS temp directory and is removed afterwards.
 *
 * Not part of `npm run check` because `dotnet build` restores NuGet packages (network) and most dev machines have no
 * .NET SDK (`check.mjs` must stay offline, PRO-12). Without `dotnet` the script prints "skipped" and exits 0; CI sets
 * `--require-dotnet` so a missing SDK fails there instead. Without CI the same compile happens in Unity (QST-03,
 * docs/testing/quest.md); manual steps: docs/testing/protocol.md.
 *
 * Options: `--require-dotnet`; `--dotnet <path>` (default `$DOTNET`, else `dotnet` on PATH); `--framework <tfm>`
 * (library, default `netstandard2.1`); `--run-framework <tfm>` (conformance exe, default `net<SDK major>.0`);
 * `--newtonsoft-dll <path>` (reference a DLL instead of the NuGet package: offline builds; pair with a
 * `--framework` whose targeting pack is installed); `--keep` (keep the temp directory and print its path).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const shared = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  if (!args.includes(name)) return fallback;
  const value = args[args.indexOf(name) + 1];
  if (!value || value.startsWith("--")) {
    console.error(`build-cs: ${name} needs a value`);
    process.exit(2);
  }
  return value;
};
const xml = (text) =>
  String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // MSBuild escapes for characters it would otherwise evaluate in item paths
    .replace(/[%$@;*?]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const NEWTONSOFT_VERSION = "13.0.2";
const dotnet = option("--dotnet", process.env.DOTNET || "dotnet");
const env = {
  ...process.env,
  DOTNET_NOLOGO: "1",
  DOTNET_CLI_TELEMETRY_OPTOUT: "1",
  DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
};

function run(command, commandArgs) {
  return spawnSync(command, commandArgs, { encoding: "utf8", env, timeout: 600_000 });
}

const version = run(dotnet, ["--version"]);
if (version.error || version.status !== 0) {
  const message =
    "build-cs: dotnet not found — skipped (docs/testing/protocol.md, C# compile check)";
  if (flag("--require-dotnet")) {
    console.error(message.replace("skipped", "required by --require-dotnet"));
    process.exit(1);
  }
  console.log(message);
  process.exit(0);
}
const sdkMajor = version.stdout.trim().split(".")[0];
const libFramework = option("--framework", "netstandard2.1");
const runFramework = option("--run-framework", `net${sdkMajor}.0`);
const newtonsoftDll = option("--newtonsoft-dll", null);
for (const tfm of [libFramework, runFramework])
  if (!/^[A-Za-z0-9.-]+$/.test(tfm)) {
    console.error(`build-cs: invalid target framework "${tfm}"`);
    process.exit(2);
  }
const csDir = resolve(shared, "cs/RemoteView.Protocol");

const newtonsoft = newtonsoftDll
  ? `<Reference Include="Newtonsoft.Json"><HintPath>${xml(resolve(newtonsoftDll))}</HintPath></Reference>`
  : `<PackageReference Include="Newtonsoft.Json" Version="${NEWTONSOFT_VERSION}" />`;
const common = `<LangVersion>9.0</LangVersion>
    <Nullable>disable</Nullable>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>`;

const work = mkdtempSync(resolve(tmpdir(), "remoteview-cs-"));
let exitCode = 0;
try {
  mkdirSync(resolve(work, "lib"));
  mkdirSync(resolve(work, "conformance"));
  writeFileSync(
    resolve(work, "lib/RemoteView.Protocol.csproj"),
    `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>${libFramework}</TargetFramework>
    ${common}
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="${xml(csDir)}/*.cs" />
    ${newtonsoft}
  </ItemGroup>
</Project>
`,
  );
  writeFileSync(
    resolve(work, "conformance/Conformance.csproj"),
    `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>${runFramework}</TargetFramework>
    ${common}
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="${xml(resolve(shared, "scripts/cs-conformance/Program.cs"))}" />
    <ProjectReference Include="../lib/RemoteView.Protocol.csproj" />
    ${newtonsoft}
  </ItemGroup>
</Project>
`,
  );

  const build = run(dotnet, ["build", resolve(work, "lib"), "-c", "Release", "--nologo"]);
  if (build.status !== 0) {
    console.error(
      `build-cs: dotnet build (${libFramework}) failed\n${build.error?.message ?? ""}${build.stdout}${build.stderr}`,
    );
    exitCode = 1;
  } else {
    console.log(
      `build-cs: RemoteView.Protocol compiles (${libFramework}, LangVersion 9.0, SDK ${version.stdout.trim()})`,
    );
    const conformance = run(
      dotnet,
      [
        "run",
        "--project",
        resolve(work, "conformance"),
        "-c",
        "Release",
        "--",
        resolve(shared, "fixtures"),
      ],
      {},
    );
    process.stdout.write(conformance.stdout ?? "");
    process.stderr.write(conformance.stderr ?? "");
    if (conformance.status !== 0) exitCode = 1;
  }
} finally {
  if (flag("--keep")) console.log(`build-cs: kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
process.exit(exitCode);
