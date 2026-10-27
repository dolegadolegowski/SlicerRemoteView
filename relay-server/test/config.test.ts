import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConfigError, ENV_VARIABLES, loadConfig, PLATFORM_INPUTS } from "../src/config.js";
import type { Config, Env } from "../src/config.js";
import { childEnv } from "./helpers/env.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** `NAME=value` lines of `.env.example`, in file order. */
function envExample(): [string, string][] {
  return readFileSync(`${ROOT}.env.example`, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"))
    .map((line) => {
      const eq = line.indexOf("=");
      return [line.slice(0, eq), line.slice(eq + 1)];
    });
}

const DEFAULTS: Config = {
  port: 8787,
  logLevel: "info",
  metricsToken: undefined,
  sessionTtlS: 1_800,
  publisherGraceS: 120,
  sessionMaxLifetimeS: 43_200,
  codeQuarantineS: 600,
  maxSnapshotBytes: 67_108_864,
  maxTotalSnapshotBytes: 536_870_912,
  maxTotalBufferedBytes: 167_772_160,
  maxViewers: 20,
  maxSessions: 100,
  allowedOrigins: [],
  trustProxy: true,
  drainingSeconds: 30,
  testFastTimers: false,
};

const expectConfigError = (env: Env, variable: string): ConfigError => {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).variable).toBe(variable);
    expect((error as Error).message).toContain(variable);
    return error as ConfigError;
  }
  throw new Error(`expected ConfigError for ${variable}`);
};

describe("defaults (SRV-02 criterion 1: protocol §3.3, architecture §9)", () => {
  it("an empty environment yields the documented defaults", () => {
    expect(loadConfig({})).toEqual(DEFAULTS);
  });

  it("LOG_LEVEL ignores case", () => {
    expect(loadConfig({ LOG_LEVEL: "DEBUG" }).logLevel).toBe("debug");
  });

  it("empty strings count as unset", () => {
    expect(loadConfig(Object.fromEntries(ENV_VARIABLES.map((name) => [name, ""])))).toEqual(
      DEFAULTS,
    );
  });

  it("ALLOWED_ORIGINS defaults to https://${RAILWAY_PUBLIC_DOMAIN}", () => {
    expect(loadConfig({ RAILWAY_PUBLIC_DOMAIN: "relay.up.railway.app" }).allowedOrigins).toEqual([
      "https://relay.up.railway.app",
    ]);
  });

  it("parses every variable", () => {
    const config = loadConfig({
      PORT: "9000",
      LOG_LEVEL: "warn",
      METRICS_TOKEN: "m".repeat(40),
      SESSION_TTL_S: "60",
      PUBLISHER_GRACE_S: "30",
      SESSION_MAX_LIFETIME_S: "3600",
      CODE_QUARANTINE_S: "60",
      MAX_SNAPSHOT_BYTES: "1048576",
      MAX_TOTAL_SNAPSHOT_BYTES: "2097152",
      MAX_TOTAL_BUFFERED_BYTES: "8388608",
      MAX_VIEWERS: "5",
      MAX_SESSIONS: "3",
      ALLOWED_ORIGINS:
        " http://localhost:5173 , https://Relay.Example.org:443/ ,http://127.0.0.1:8787,http://[::1]:5173",
      TRUST_PROXY: "false",
      RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "0",
    });
    expect(config).toEqual({
      port: 9000,
      logLevel: "warn",
      metricsToken: "m".repeat(40),
      sessionTtlS: 60,
      publisherGraceS: 30,
      sessionMaxLifetimeS: 3_600,
      codeQuarantineS: 60,
      maxSnapshotBytes: 1_048_576,
      maxTotalSnapshotBytes: 2_097_152,
      maxTotalBufferedBytes: 8_388_608,
      maxViewers: 5,
      maxSessions: 3,
      allowedOrigins: [
        "http://localhost:5173",
        "https://relay.example.org",
        "http://127.0.0.1:8787",
        "http://[::1]:5173",
      ],
      trustProxy: false,
      drainingSeconds: 0,
      testFastTimers: false,
    });
  });
});

describe("invalid values fail fast with the variable name (SRV-02 criterion 2)", () => {
  it.each([
    ["PORT", "-1"],
    ["PORT", "65536"],
    ["PORT", "80.5"],
    ["SESSION_TTL_S", "-5"],
    ["SESSION_TTL_S", "0"],
    ["SESSION_TTL_S", "1.5"],
    ["SESSION_TTL_S", "1e3"],
    ["SESSION_TTL_S", "0x10"],
    ["SESSION_TTL_S", "abc"],
    ["PUBLISHER_GRACE_S", "-120"],
    ["SESSION_MAX_LIFETIME_S", "forever"],
    ["CODE_QUARANTINE_S", "-1"],
    ["CODE_QUARANTINE_S", "0"],
    ["CODE_QUARANTINE_S", "59"],
    ["SESSION_TTL_S", "1801"],
    ["PUBLISHER_GRACE_S", "121"],
    ["SESSION_MAX_LIFETIME_S", "43201"],
    ["MAX_TOTAL_SNAPSHOT_BYTES", "134217727"],
    ["MAX_TOTAL_BUFFERED_BYTES", "8388607"],
    ["MAX_SNAPSHOT_BYTES", "67108865"],
    ["MAX_SNAPSHOT_BYTES", "0"],
    ["MAX_TOTAL_SNAPSHOT_BYTES", "1024"],
    ["MAX_TOTAL_BUFFERED_BYTES", "-1"],
    ["MAX_TOTAL_BUFFERED_BYTES", "99999999999999999999"],
    ["MAX_VIEWERS", "21"],
    ["MAX_VIEWERS", "0"],
    ["MAX_SESSIONS", "0"],
    ["MAX_SESSIONS", "1.0"],
    ["RAILWAY_DEPLOYMENT_DRAINING_SECONDS", "-30"],
    ["LOG_LEVEL", "verbose"],
    ["LOG_LEVEL", "1"],
    ["TRUST_PROXY", "yes"],
    ["ALLOWED_ORIGINS", "not a url"],
    ["ALLOWED_ORIGINS", "https://relay.example.org/path"],
    ["ALLOWED_ORIGINS", "ftp://relay.example.org"],
    ["ALLOWED_ORIGINS", "https://user:pw@relay.example.org"],
    ["ALLOWED_ORIGINS", "https://relay.example.org?x=1"],
    ["ALLOWED_ORIGINS", "https://relay.example.org#x"],
    ["ALLOWED_ORIGINS", "https://*.example.org"],
    ["ALLOWED_ORIGINS", "http://relay.example.org"],
    ["ALLOWED_ORIGINS", "null"],
    ["RAILWAY_PUBLIC_DOMAIN", "*.up.railway.app"],
    ["METRICS_TOKEN", "short"],
    ["METRICS_TOKEN", `${"m".repeat(20)} ${"m".repeat(20)}`],
  ])("%s=%s", (variable, value) => {
    expectConfigError({ [variable]: value }, variable);
  });

  it("a bad RAILWAY_PUBLIC_DOMAIN is reported under its own name", () => {
    expectConfigError({ RAILWAY_PUBLIC_DOMAIN: "bad domain/x" }, "RAILWAY_PUBLIC_DOMAIN");
  });

  it("never echoes the offending value (METRICS_TOKEN is a secret)", () => {
    const secret = "s3cr3t-but-too-short";
    expect(expectConfigError({ METRICS_TOKEN: secret }, "METRICS_TOKEN").message).not.toContain(
      secret,
    );
    expect(expectConfigError({ MAX_VIEWERS: "4242" }, "MAX_VIEWERS").message).not.toContain("4242");
  });
});

describe(".env.example (SRV-02 criterion 3)", () => {
  it("lists exactly the configuration variables, in order", () => {
    expect(envExample().map(([name]) => name)).toEqual([...ENV_VARIABLES]);
  });

  it("lists exactly the variables loadConfig reads, apart from the platform inputs", () => {
    const read = new Set<string>();
    const tracking = new Proxy<Env>(
      { NODE_ENV: "test" },
      {
        get(target, key) {
          if (typeof key === "string") read.add(key);
          return Reflect.get(target, key) as unknown;
        },
      },
    );
    loadConfig(tracking);
    const platform = new Set<string>(PLATFORM_INPUTS);
    expect([...read].filter((name) => !platform.has(name)).sort()).toEqual(
      envExample()
        .map(([name]) => name)
        .sort(),
    );
    expect([...read].filter((name) => platform.has(name)).sort()).toEqual(
      [...PLATFORM_INPUTS].sort(),
    );
  });

  it("its values are the defaults", () => {
    expect(loadConfig(Object.fromEntries(envExample()))).toEqual(DEFAULTS);
  });

  it("does not mention the test-only RELAY_TEST_FAST_TIMERS", () => {
    expect(readFileSync(`${ROOT}.env.example`, "utf8")).not.toContain("RELAY_TEST_FAST_TIMERS");
  });
});

describe("RELAY_TEST_FAST_TIMERS (test-only, SRV-21, SRV-29)", () => {
  it("is honoured under NODE_ENV=test", () => {
    expect(loadConfig({ NODE_ENV: "test", RELAY_TEST_FAST_TIMERS: "1" }).testFastTimers).toBe(true);
  });

  it.each(["production", "development", "TEST", " test", "test ", "", undefined])(
    "is ignored under NODE_ENV=%j (exactly `test` only)",
    (nodeEnv) => {
      const env: Record<string, string> = { RELAY_TEST_FAST_TIMERS: "1" };
      if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
      expect(loadConfig(env).testFastTimers).toBe(false);
    },
  );

  it.each(["RAILWAY_PUBLIC_DOMAIN", "RAILWAY_REPLICA_ID"])(
    "is refused with %s present, even empty",
    (name) => {
      for (const value of ["x", ""])
        expect(() =>
          loadConfig({ NODE_ENV: "test", RELAY_TEST_FAST_TIMERS: "1", [name]: value }),
        ).toThrow(expect.objectContaining({ variable: "RELAY_TEST_FAST_TIMERS" }));
    },
  );

  it("refuses to start on Railway (RAILWAY_PUBLIC_DOMAIN set), naming the flag", () => {
    const railway = { RAILWAY_PUBLIC_DOMAIN: "relay.up.railway.app", RELAY_TEST_FAST_TIMERS: "1" };
    expect(() => loadConfig({ ...railway, NODE_ENV: "test" })).toThrow(
      expect.objectContaining({ name: "ConfigError", variable: "RELAY_TEST_FAST_TIMERS" }),
    );
    // Where it would change nothing, it stops nothing.
    expect(loadConfig({ ...railway, NODE_ENV: "production" }).testFastTimers).toBe(false);
    expect(loadConfig({ ...railway, NODE_ENV: "test", RELAY_TEST_FAST_TIMERS: "0" })).toMatchObject(
      { testFastTimers: false },
    );
  });
});

describe("start-up (src/index.ts)", () => {
  it("exits 1 naming the variable when the configuration is invalid", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: ROOT,
      env: childEnv({ PORT: "0", MAX_VIEWERS: "21" }),
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(result.status).toBe(1);
    const entry = result.stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as { level: string; message: string; variable: string })
      .find((line) => line.level === "fatal");
    expect(entry).toMatchObject({ level: "fatal", variable: "MAX_VIEWERS" });
    expect(entry!.message).toContain("MAX_VIEWERS");
  }, 20_000);
});
