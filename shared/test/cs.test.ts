import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CS_OUT_DIR, renderCs } from "../scripts/generate-cs.mjs";
import { bundleSchemas } from "../scripts/lib/bundle.mjs";
import { ERROR_CODES } from "../ts/index.js";
import { SCHEMA_DIR } from "./helpers.js";

const GENERATE_CS = resolve(__dirname, "../scripts/generate-cs.mjs");
const BUILD_CS = resolve(__dirname, "../scripts/build-cs.mjs");
const { messageNames, typeByName } = bundleSchemas(SCHEMA_DIR);
const pascal = (code: string) =>
  code
    .toLowerCase()
    .split("_")
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");

let fresh: Map<string, string>;
let messages: string;
let messageTypes: string;
beforeEach(async () => {
  fresh ??= await renderCs();
  messages = fresh.get("Messages.cs")!;
  messageTypes = fresh.get("MessageTypes.cs")!;
}, 60_000);

describe("C# generation (PRO-17)", () => {
  it("is deterministic and the committed shared/cs/RemoteView.Protocol is a fresh generation", async () => {
    const again = await renderCs();
    expect([...again.keys()].sort()).toEqual(["MessageTypes.cs", "Messages.cs"]);
    for (const [name, content] of again) {
      expect(content, name).toBe(fresh.get(name));
      expect(readFileSync(resolve(CS_OUT_DIR, name), "utf8"), `committed ${name}`).toBe(content);
    }
    expect(readdirSync(CS_OUT_DIR).sort()).toEqual(["MessageTypes.cs", "Messages.cs"]);
  }, 60_000);

  it("has one class per message type, registered under its type string", () => {
    expect(messageNames).toHaveLength(28);
    for (const name of messageNames) {
      // quicktype adds a second partial declaration per class holding `FromJson`; only one carries the properties.
      const declarations = [
        ...messages.matchAll(new RegExp(`^ {4}public partial class ${name}\\n`, "gm")),
      ];
      const withProperties = declarations.filter((match) => {
        const start = match.index!;
        return messages
          .slice(start, messages.indexOf("\n    }\n", start))
          .includes("[JsonProperty(");
      });
      expect(withProperties, `${name} declared once with properties`).toHaveLength(1);
      const type = typeByName[name]!;
      expect(messages, `${name}.Type default`).toContain(
        `public string Type { get; set; } = ${JSON.stringify(type)};`,
      );
      expect(messageTypes).toContain(`public const string ${name} = ${JSON.stringify(type)};`);
      expect(messageTypes).toContain(`{ ${name}, typeof(RemoteView.Protocol.${name}) },`);
    }
  });

  it("uses plain classes and Newtonsoft attributes only: no record, no init, no System.Text.Json", () => {
    for (const [name, content] of fresh) {
      expect(content, name).not.toMatch(/\brecord\b/);
      expect(content, name).not.toMatch(/\binit\s*;/);
      expect(content, name).not.toContain("System.Text.Json");
      expect(content, name).not.toContain("\t");
    }
    expect(messages).toContain("using Newtonsoft.Json;");
    expect(messages).not.toMatch(/MinMaxLengthCheckConverter|Purple|Fluffy/);
  });

  it('names every wire property of every class with [JsonProperty("camelCase")] inside that class', () => {
    const bundle = bundleSchemas(SCHEMA_DIR).bundle as {
      definitions: Record<string, { properties?: Record<string, unknown> }>;
    };
    /** Body of the declaration that carries the properties of `name` (the second `partial` only holds FromJson). */
    const classBody = (name: string) => {
      for (const match of messages.matchAll(
        new RegExp(`^ {4}public partial class ${name}\\n`, "gm"),
      )) {
        const body = messages.slice(match.index, messages.indexOf("\n    }\n", match.index));
        if (body.includes("[JsonProperty(")) return body;
      }
      throw new Error(`no class ${name} with properties`);
    };
    // Message classes carry their definition's name; the nested shapes of `defs` are the same name in camelCase.
    const shapes = ["ClientInfo", "NodeChange", "SnapshotInfo", "Ttl", "Limits"];
    for (const name of [...messageNames, ...shapes]) {
      const definition =
        bundle.definitions[name] ?? bundle.definitions[name[0]!.toLowerCase() + name.slice(1)];
      const properties = Object.keys(definition?.properties ?? {});
      expect(properties.length, name).toBeGreaterThan(0);
      const body = classBody(name);
      for (const property of properties) {
        expect(property, "camelCase wire name").toMatch(/^[a-z][A-Za-z0-9]*$/);
        expect(body, `${name}.${property}`).toMatch(
          new RegExp(`\\[JsonProperty\\("${property}"[,)]`),
        );
      }
    }
  });

  it("generates an enum with an Other fallback for errorCode, every *Reason and platform", () => {
    const enums = [
      ...messages.matchAll(
        /^ {4}\[JsonConverter\(typeof\((\w+)Converter\)\)\]\n {4}public enum (\w+) \{ ([^}]*) \};$/gm,
      ),
    ];
    const byName = new Map(enums.map((m) => [m[2]!, m[3]!.split(", ")]));
    expect([...byName.keys()]).toEqual(
      expect.arrayContaining([
        ...[
          "ErrorCode",
          "Platform",
          "SceneRequestReason",
          "SnapshotAbortReason",
          "SessionEndReason",
        ],
        ...["SessionCloseReason", "SessionExpiringReason", "NodeKind", "Profile", "SnapshotFormat"],
      ]),
    );
    for (const [name, members] of byName) {
      expect(members, name).toContain("Other");
      expect(messages, `${name} converter`).toMatch(
        new RegExp(`return ${name}\\.Other; // unknown wire value`),
      );
    }
    const defs = (
      bundleSchemas(SCHEMA_DIR).bundle as { definitions: Record<string, { enum?: string[] }> }
    ).definitions;
    const enumDefinitions: Record<string, string> = {
      NodeKind: "nodeKind",
      Profile: "profile",
      SnapshotFormat: "snapshotFormat",
      GltfExtension: "gltfExtension",
      SceneRequestReason: "sceneRequestReason",
      SnapshotAbortReason: "snapshotAbortReason",
      SessionEndReason: "sessionEndReason",
      SessionCloseReason: "sessionCloseReason",
      SessionExpiringReason: "sessionExpiringReason",
    };
    // wire spelling -> C# member: `GAP` -> Gap, `quest-browser` -> QuestBrowser, `KHR_mesh_quantization` -> KhrMeshQuantization
    const member = (value: string) =>
      value
        .toLowerCase()
        .split(/[-_]/)
        .map((part) => part[0]!.toUpperCase() + part.slice(1))
        .join("");
    for (const [csName, defName] of Object.entries(enumDefinitions)) {
      const wire = defs[defName]?.enum ?? [];
      expect(wire.length, defName).toBeGreaterThan(0);
      expect([...byName.get(csName)!].sort(), csName).toEqual(
        [...wire.map(member), "Other"].sort(),
      );
    }
    expect(byName.get("ErrorCode")!.sort()).toEqual([...ERROR_CODES.map(pascal), "Other"].sort());
    expect(byName.get("Platform")).toEqual(["Other", "Quest2", "Quest3", "QuestBrowser", "Web"]);
    expect(messages).not.toContain("Cannot unmarshal type");
  });

  it("writes error codes by their wire spelling", () => {
    for (const code of ERROR_CODES)
      expect(messages).toContain(`serializer.Serialize(writer, "${code}");`);
  });
});

describe("C# drift check (ADR 0007 §4)", () => {
  let work: string;
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [GENERATE_CS, ...args, "--out-dir", work], { encoding: "utf8" });
  beforeEach(() => {
    work = mkdtempSync(resolve(tmpdir(), "remoteview-cs-drift-"));
    cpSync(CS_OUT_DIR, work, { recursive: true });
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  it("passes on a fresh generation and writes nothing", () => {
    const result = run("--check");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
  }, 60_000);

  it("fails and names the file when a generated file is modified, deleted or an extra .cs appears", () => {
    writeFileSync(
      resolve(work, "Messages.cs"),
      messages.replace("public partial", "public sealed"),
    );
    let result = run("--check");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Messages\.cs is out of date/);

    rmSync(resolve(work, "MessageTypes.cs"));
    result = run("--check");
    expect(result.stderr).toMatch(/MessageTypes\.cs is missing/);

    writeFileSync(resolve(work, "Extra.cs"), "// not generated\n");
    result = run("--check");
    expect(result.stderr).toMatch(/Extra\.cs is not generated/);
  }, 60_000);

  it("rejects a missing or unknown argument instead of defaulting to the working directory", () => {
    for (const args of [["--out-dir"], ["--out-dir", "--check"], ["--bogus"]]) {
      const result = spawnSync(process.execPath, [GENERATE_CS, ...args], {
        encoding: "utf8",
        cwd: work,
      });
      expect(result.status, args.join(" ")).toBe(2);
      expect(result.stderr).toMatch(/usage:/);
    }
    expect(readdirSync(work).sort()).toEqual(["MessageTypes.cs", "Messages.cs"]);
  });

  it("regenerating repairs the directory, deletes stale generated files and keeps hand-written ones", () => {
    writeFileSync(resolve(work, "Messages.cs"), "// tampered\n");
    writeFileSync(resolve(work, "Stale.cs"), messageTypes);
    writeFileSync(resolve(work, "Mine.cs"), "// hand-written\n");
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(work).sort()).toEqual(["MessageTypes.cs", "Messages.cs", "Mine.cs"]);
    expect(readFileSync(resolve(work, "Messages.cs"), "utf8")).toBe(messages);
    expect(readFileSync(resolve(work, "Mine.cs"), "utf8")).toBe("// hand-written\n");
  }, 60_000);
});

describe("C# compile check script", () => {
  it("skips with exit 0 when dotnet is missing, and fails with --require-dotnet", () => {
    const missing = resolve(tmpdir(), "no-such-dotnet-binary");
    const skipped = spawnSync(process.execPath, [BUILD_CS, "--dotnet", missing], {
      encoding: "utf8",
    });
    expect(skipped.status, skipped.stderr).toBe(0);
    expect(skipped.stdout).toMatch(/dotnet not found — skipped/);
    const required = spawnSync(
      process.execPath,
      [BUILD_CS, "--dotnet", missing, "--require-dotnet"],
      {
        encoding: "utf8",
      },
    );
    expect(required.status).toBe(1);
    expect(required.stderr).toMatch(/required by --require-dotnet/);
  });

  // Opt-in: `dotnet build` restores NuGet packages (network). CI runs `npm run check:cs -w shared -- --require-dotnet`.
  it.runIf(process.env["RUN_DOTNET_TESTS"] === "1")(
    "compiles on netstandard2.1 and passes the C# conformance run",
    () => {
      const result = spawnSync(process.execPath, [BUILD_CS, "--require-dotnet"], {
        encoding: "utf8",
      });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(result.stdout).toMatch(/C# conformance: \d+ valid fixtures, \d+ checks, 0 failure/);
    },
    600_000,
  );
});
