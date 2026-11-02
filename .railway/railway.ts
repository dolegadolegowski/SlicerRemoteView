/**
 * Railway Infrastructure as Code for the relay (DEP-04; ADR 0007 §6–7; docs/architecture.md §9).
 *
 * Railway never reads this file during a deploy: it changes the project only through `railway config plan` and
 * `railway config apply` (the owner locally, or .github/workflows/railway.yml). Field names: the `railway` SDK
 * 3.16.0 types and docs/research/deploy-railway-iac.md §2 — the ones only the types confirm are `[TODO verify]`
 * until the first `railway config plan` against the live service shows no unexpected change (docs/deploy.md §1).
 *
 * `apply` makes the project equal to this file: a service missing here is deleted, and so is a variable of this
 * service missing from `env`. Variables whose value must not be in the repository (`ALLOWED_ORIGINS` names the
 * owner's domain, `METRICS_TOKEN` is a secret) are `preserve()`: declared, value kept from the dashboard.
 *
 * Not declared on purpose:
 * - the region: pick an EU region in the dashboard (ADR 0007 §6); the CLI should keep the current one for a plain
 *   `replicas: 1` (`[TODO verify]` with the first plan, docs/research/deploy-railway-iac.md §3);
 * - the generated `*.up.railway.app` domain (IaC cannot express it) and custom domains (docs/deploy.md §5);
 * - `PORT` and `RAILWAY_PUBLIC_DOMAIN` (injected by Railway), `NODE_OPTIONS` (set by relay-server/Dockerfile, a
 *   Railway variable would override it), `RELAY_TEST_FAST_TIMERS` (test-only) — the env parity check
 *   (.github/scripts/check-env-parity.mjs) knows these exceptions.
 */
import { defineRailway, github, preserve, service } from "railway/iac";

/** The service's name in the Railway dashboard: rename the service, or this constant, before the first plan. */
const SERVICE_NAME = "relay";
/** The GitHub repository Railway deploys from; a fork puts its own `<owner>/<repo>` here. */
const REPOSITORY = "dolegadolegowski/SlicerRemoteView";

/**
 * Deploy only when the relay image's inputs change (docs/user-guide/en/own-server.md, "Good to know"):
 * gitignore-style, a `!` line removes what an earlier line added.
 */
const WATCH_PATTERNS = [
  "/relay-server/**",
  "!/relay-server/test/",
  "!/relay-server/test/**",
  "!/relay-server/scripts/",
  "!/relay-server/scripts/**",
  "!/relay-server/README.md",
  "/shared/**",
  "/web-viewer/**",
  "/package*.json",
  "/tools/fake-slicer/package.json",
  "/.dockerignore",
];

const relay = service(SERVICE_NAME, {
  // Root directory "/" (the default): the Dockerfile copies shared/ and web-viewer/ (ADR 0007 §5).
  // checkSuites = "Wait for CI": a commit deploys only after its GitHub Actions runs passed (docs/deploy.md §7.3).
  source: github(REPOSITORY, { branch: "main", checkSuites: true }),
  build: {
    builder: "DOCKERFILE",
    dockerfilePath: "/relay-server/Dockerfile",
    watchPatterns: WATCH_PATTERNS,
  },
  // In-memory sessions: exactly one replica (ADR 0006, ADR 0007 §6).
  replicas: 1,
  healthcheck: "/healthz",
  healthcheckTimeout: 300,
  deploy: {
    // Never asleep: a sleeping relay drops its sessions.
    sleepApplication: false,
    restartPolicyType: "ON_FAILURE",
    restartPolicyMaxRetries: 10,
    // A memory cap per replica belongs here, not in the dashboard (an apply reverts dashboard values), once its
    // shape is confirmed with `railway config pull --json` and its size agreed with `server` (docs/deploy.md §6):
    // limitOverride: { containers: { memoryBytes: <bytes> } },
  },
  // docs/architecture.md §9, values = relay-server/.env.example defaults (the relay's own defaults).
  env: {
    LOG_LEVEL: "info",
    METRICS_TOKEN: preserve(),
    SESSION_TTL_S: "1800",
    PUBLISHER_GRACE_S: "120",
    SESSION_MAX_LIFETIME_S: "43200",
    CODE_QUARANTINE_S: "600",
    MAX_SNAPSHOT_BYTES: "67108864",
    MAX_TOTAL_SNAPSHOT_BYTES: "536870912",
    MAX_TOTAL_BUFFERED_BYTES: "167772160",
    MAX_VIEWERS: "20",
    MAX_SESSIONS: "100",
    // `https://<your-domain>` set in the dashboard (docs/deploy.md §2); empty = https://${RAILWAY_PUBLIC_DOMAIN}.
    ALLOWED_ORIGINS: preserve(),
    // The Railway edge is the only proxy in front (DEP-06 confirms the hop count).
    TRUST_PROXY: "true",
    // Read by Railway (SIGTERM → SIGKILL window) and by the relay (its 4008 drain), so a variable, not a setting.
    RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "30",
  },
});

export default defineRailway((ctx, project) =>
  // The linked project's own name, so that no project name lives in the repository.
  project(ctx.projectName ?? "slicerremoteview", { resources: [relay] }),
);
