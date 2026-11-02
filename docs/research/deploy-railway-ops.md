# Research — Railway operational facts for `docs/deploy.md`

Status/date: research note (deploy workstream), 2026-11-02. Re-verifies `docs/research/relay.md` §1.3–1.10
(2026-10-17) against the current Railway docs (docs.railway.com, read through Railway's docs search/fetch on
2026-11-02). Every fact is followed by its source. Unverified items are marked `[TODO verify]`.
Placeholders only: `<service>.up.railway.app`, `relay.example.com`; no real project/domain/region of ours.
Verified by an independent re-check on 2026-11-02; corrections: 8

Changes vs `relay.md`: (a) Wait for CI exists and is documented (§10); (b) Monitors (Pro) can alert on network
egress (§4); (c) Hobby per-replica limit 8 vCPU / 8 GB and per-service limit 48 vCPU / 48 GB (6 replicas × 8) are
consistent, not conflicting (§4.7); (d) `.dockerignore` is now mentioned once (§9); (e) the TypeScript IaC reference uses region key
`europe-west4`, the regions page and Config-as-Code reference `europe-west4-drams3a` (§7.3). Everything else in §1.3–1.10 still holds.

## 1. Healthchecks

1.1 Configured as a path in service settings (e.g. `/health`); Railway polls it on a new deployment until it
gets any `2xx`; only then the new deployment becomes active. https://docs.railway.com/deployments/healthchecks
(A guide says "HTTP `200`": https://railway.com/guides/roll-back-bad-deploy#prevent-bad-deploys-with-a-healthcheck —
return exactly `200` to satisfy both; https://docs.railway.com/deployments/troubleshooting/slow-deployments (section "Network (healthchecks)")
also says "HTTP 200".)
1.2 Default timeout 300 s; change it in service settings or with `RAILWAY_HEALTHCHECK_TIMEOUT_SEC`; on timeout the
deploy is marked failed and the previous deployment keeps serving.
https://docs.railway.com/deployments/healthchecks ; https://docs.railway.com/variables/reference#user-provided-configuration-variables ;
https://railway.com/guides/roll-back-bad-deploy#prevent-bad-deploys-with-a-healthcheck
1.3 Healthcheck uses the injected `PORT`; with manual target ports set `PORT` yourself.
https://docs.railway.com/deployments/healthchecks#configure-the-healthcheck-port
1.4 Requests come with hostname `healthcheck.railway.app`; host allow-lists must accept it (else
"service unavailable"/400). https://docs.railway.com/deployments/healthchecks#healthcheck-hostname
1.5 Deploy-time only: "not used for continuous monitoring"; use an external pinger.
https://docs.railway.com/deployments/healthchecks#continuous-healthchecks
1.6 Services with a volume get brief downtime on redeploy even with a healthcheck (we have no volume).
https://docs.railway.com/deployments/healthchecks#services-with-attached-volumes
1.7 IaC field names: `healthcheck: "/health"`, `healthcheckTimeout: 30`. https://docs.railway.com/infrastructure-as-code/reference#healthchecks

## 2. Deployments, shutdown, restart policy

2.1 States: Initializing → Building → Deploying (waits for healthcheck) → Active; older Active/Completed/Crashed
deployments go Removing → Removed. https://docs.railway.com/deployments/reference#deployment-states
2.2 Singleton deploys: once the new deployment is online the old one gets SIGTERM, "0 seconds to gracefully
shutdown" by default, then SIGKILL; no other signals. https://docs.railway.com/deployments/reference#singleton-deploys
2.3 `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` = SIGTERM→SIGKILL window, default `0`;
`RAILWAY_DEPLOYMENT_OVERLAP_SECONDS` = old/new overlap, default `0`.
https://docs.railway.com/variables/reference#user-provided-configuration-variables
2.4 Railway may itself redeploy a service (host migration, security updates, faults); mandatory, cannot opt out.
https://docs.railway.com/deployments/reference#railway-initiated-deployments
2.5 During "Limited Access" periods Railway may suspend resource allocation incl. builds for Free "and more rarely
Hobby"; new deployments are queued; Pro/Enterprise are not affected.
https://docs.railway.com/deployments/reference#deployments-paused---limited-access
2.6 Rollback restores a removed deployment's image only within image retention: Free/Trial 24 h, Hobby 72 h,
Pro 120 h; after that "Redeploy" rebuilds from source. https://docs.railway.com/pricing/plans#image-retention-policy
2.7 Restart policy default `On Failure`, max 10 restarts; options `Always` / `On Failure` / `Never`; Free and
trial: `Always` unavailable and `On Failure` capped at 10; paid plans: any policy, any count.
https://docs.railway.com/deployments/restart-policy
2.8 OOM shows as exit code 137 (crash → restart policy applies). https://docs.railway.com/deployments/troubleshooting/slow-deployments#resource-constraints

## 3. Custom domains and TLS

3.1 Generated domain is not automatic: Settings → Networking → Public Networking → `Generate Domain`.
https://docs.railway.com/networking/domains/working-with-domains#railway-provided-domains
3.2 Custom domain: `+ Custom Domain` gives a `CNAME` (target like `<x>.up.railway.app`) and a `TXT` ownership
record; both required; without the TXT the domain returns `404` even if the CNAME resolves; DNS may take up to
72 h. https://docs.railway.com/networking/domains/working-with-domains#custom-domains ; https://docs.railway.com/cli/domain#custom-domain-setup
3.3 Apex domains need CNAME flattening / ALIAS / ANAME at the DNS provider (not Route 53, GoDaddy, etc.).
https://docs.railway.com/networking/domains/working-with-domains#adding-a-root-domain
3.4 Let's Encrypt, ECDSA, 90-day certs, auto-renew at 30 days left; issuance "within an hour", "up to 72 hours in
some cases"; external certificates not supported; Let's Encrypt limit of 5 duplicate certs per domain per week (hitting it
blocks issuance for 7 days), so do not delete/re-add a domain repeatedly. https://docs.railway.com/networking/domains/working-with-domains#ssl-certificates ;
https://docs.railway.com/networking/troubleshooting/ssl
3.5 Limits: Trial 1 custom domain; Hobby 2 per service; Pro 20 per service (more on request).
https://docs.railway.com/networking/domains/working-with-domains#important-considerations . Pricing page: Free 0,
Hobby 2, Pro 20. https://railway.com/pricing
3.6 HTTP→HTTPS: "Railway redirects HTTP to HTTPS" (stated in the Cloudflare Flexible redirect-loop explanation).
https://docs.railway.com/networking/troubleshooting/ssl#err_too_many_redirects
3.7 Cloudflare proxied (orange cloud): SSL/TLS mode must be **Full**, not Full (Strict) (Railway may serve the
`*.up.railway.app` cert during issuance/renewal) and not Flexible (redirect loop). For proxied domains Railway
may not issue a cert; Cloudflare→Railway is then TLS with the `*.up.railway.app` certificate. Deeper than
first-level subdomain needs Cloudflare ACM or DNS-only.
https://docs.railway.com/networking/domains/working-with-domains#cloudflare-configuration ; https://docs.railway.com/networking/troubleshooting/ssl#error-526-invalid-ssl-certificate
3.8 Wildcards supported (`*.example.com`, not nested `*.*`); need two CNAMEs (wildcard + `_acme-challenge`, the
latter never proxied) plus the TXT. Not needed for us.
https://docs.railway.com/networking/domains/working-with-domains#wildcard-domains
3.9 Fallback: "One Railway-provided domain per service" and "Multiple custom domains can be added per service",
so the generated `<service>.up.railway.app` can stay next to `relay.example.com`; `railway domain delete`
deletes "a custom or service domain". https://docs.railway.com/cli/domain#limits ;
https://docs.railway.com/cli/domain#delete-a-domain . That an explicit delete is the *only* way it is removed is
not stated `[TODO verify]`. Generated domains are not part of
`.railway/railway.ts` (IaC only manages custom domains). https://docs.railway.com/infrastructure-as-code/reference#custom-domains
That adding a custom domain never auto-removes the generated one is implied, not stated `[TODO verify]` on first setup.

## 4. Cost, usage limits, alerts

4.1 Usage limits: Workspace Usage page → `Set Usage Limits` → `Custom email alert` and `Hard limit`, separately
for Compute Usage and Agent Usage; workspace admin only; all plans.
https://docs.railway.com/pricing/cost-control#configuring-usage-limits
4.2 Custom email alert = soft limit, email only, nothing stops; can be set without a hard limit.
Hard limit = all workloads taken offline when reached; reminders at 75 %, 90 %, 100 %; minimum hard limit $10;
raising/removing the limit auto-redeploys stopped services.
https://docs.railway.com/pricing/cost-control#custom-email-alert ; https://docs.railway.com/pricing/cost-control#usage-limits-faq
4.3 Compute Usage covers CPU, memory, storage and network egress.
https://docs.railway.com/pricing/cost-control#compute-vs-agent-usage-limits . Limits are set as spend amounts
(minimum hard limit $10; CLI example `--soft 75 --hard 125`); no per-metric usage limit is documented (inference
from the same page, not an explicit statement). https://docs.railway.com/pricing/cost-control#usage-limits-faq
4.4 Per-metric alerts (incl. **network egress**, CPU, RAM, disk) exist only as Observability-dashboard
**Monitors** (widget ⋯ → `Add monitor`), email + in-app + webhooks, **Pro plan required**.
https://docs.railway.com/observability#monitors
4.5 Prices: RAM $10/GB/month ($0.000231/GB/min); CPU $20/vCPU/month ($0.000463/vCPU/min); network egress
$0.05/GB; volume $0.15/GB/month; builds free. https://docs.railway.com/pricing/plans#resource-usage-pricing ;
same numbers (per-second rates) on https://railway.com/pricing
4.6 Plans: Free $0 ($1 credit), Hobby $5 incl. $5 usage, Pro $20 incl. $20 usage; the Hobby fee is paid even if
usage stays below $5 (FAQ), except that Railway automatically waives it for "a small set of active builders"
(https://docs.railway.com/pricing/plans#can-i-get-the-hobby-plan-subscription-fee-waived).
https://docs.railway.com/pricing/plans#subscription-pricing ; https://docs.railway.com/pricing/plans#included-usage
4.7 Resource caps per service: Hobby 6 replicas / 48 GB / 48 vCPU; Pro 42 / 1 TB / 1,000 vCPU
(https://docs.railway.com/pricing/plans#default-plan-resources); per replica: Hobby 8 vCPU / 8 GB, Pro 24 / 24
(https://docs.railway.com/deployments/troubleshooting/slow-deployments#what-plan-upgrades-actually-do ;
https://docs.railway.com/deployments/optimize-performance#configure-horizontal-scaling). The per-service values "are maximum
values and include replica multiplication" (https://docs.railway.com/pricing/plans#default-plan-resources), so
Hobby 6 × 8 = 48 is consistent: a single-replica Hobby service is capped at 8 vCPU / 8 GB. Per-replica caps can be
lowered in Settings → Deploy → Replica Limits. https://docs.railway.com/pricing/cost-control#replica-limits

## 5. Logs

5.1 Retention: Free 3 d, Trial 7 d, Hobby 7 d, Pro 30 d, Enterprise up to 90 d; no log drains.
https://docs.railway.com/observability/logs#log-retention
5.2 Rate limit 500 lines/s per replica, all plans; excess dropped with a warning line.
https://docs.railway.com/observability/logs#logging-throughput
5.3 HTTP log fields: `timestamp, method, path, httpStatus, totalDuration, requestId, host, clientUa, srcIp,
edgeRegion, txBytes, rxBytes, upstreamRqDuration, upstreamAddress, upstreamProto, downstreamProto,
upstreamErrors, responseDetails, deploymentId, deploymentInstanceId` (+ `responseTime` filter).
https://docs.railway.com/cli/logs#http-json-output ; https://docs.railway.com/observability/logs#http-logs
5.4 No request/response header field except `host` and `clientUa` is in the documented schema; no body field.
Same sources as 5.3. Whether `path` includes the query string is still not documented (examples show none)
`[TODO verify]` with a dummy `?probe=1` request after the first deploy. Design rule stands: no codes/tokens
in path or query.
5.5 stdout → `info`, stderr → `error`; one-line JSON with `message`/`level`, extra fields searchable as
`@field:value`. https://docs.railway.com/observability/logs#structured-logs

## 6. Service metrics

6.1 Service → `Metrics` tab: CPU, Memory, Disk Usage, Network (in/out); dotted lines mark deployments;
"Up to 30 days of data" per project (no per-plan difference stated); Sum vs Replica view, public network
traffic only in Sum. https://docs.railway.com/observability/metrics
6.2 No app-level metrics (latency, error rate). https://docs.railway.com/observability/metrics#provided-metrics
6.3 Project-level Observability tab: widgets for CPU, Memory, Network In/Out, Disk, Logs, Project Usage (spend).
https://docs.railway.com/observability#available-data-sources

## 7. Regions

7.1 US West Metal (California) `us-west2`; US East Metal (Virginia) `us-east4-eqdc4a`; EU West Metal
(Amsterdam) `europe-west4-drams3a`; Southeast Asia Metal (Singapore) `asia-southeast1-eqsg3a`.
https://docs.railway.com/deployments/regions#region-options
7.2 Default = workspace preferred region (Workspace Settings); per service: Settings → Scale → Regions; change
any time without downtime when no volume is attached. https://docs.railway.com/deployments/regions ;
https://docs.railway.com/overview/advanced-concepts#deploy-options ; https://docs.railway.com/deployments/optimize-performance#set-a-preferred-region
7.3 TypeScript IaC (`.railway/railway.ts`): `replicas: { "<region>": n }`; the reference example uses key
`europe-west4`. https://docs.railway.com/infrastructure-as-code/reference#replicas . Config as Code
(`railway.json`) uses `deploy.multiRegionConfig` with keys like `europe-west4-drams3a`
(https://docs.railway.com/config-as-code/reference#multi-region-configuration), and the regions page says the
region identifier "is the value that can be used in your Config as Code file"
(https://docs.railway.com/deployments/regions#region-options). Which key `railway.ts` accepts (short
`europe-west4` vs full `europe-west4-drams3a`) is not stated `[TODO verify]`.
7.4 Hobby + EU West: current docs and pricing page show no plan gating (https://docs.railway.com/deployments/regions ;
https://railway.com/pricing); the only explicit statement found is a moderator answer of 2025-01-06 that Hobby
could not yet deploy to the EU (https://station.railway.com/questions/eu-support-for-hobby-plan-e32b309f),
predating the current docs `[TODO verify]` in the dashboard region picker before choosing Hobby.

## 8. Watch paths

8.1 gitignore-style patterns, one per line; changes not matching skip the deployment.
https://docs.railway.com/builds/build-configuration#configure-watch-paths
8.2 Negation with `!` supported, "only work if you include files in a preceding rule" (e.g. `**` then
`!/*.md`). Same source.
8.3 Patterns always operate from the repo root `/`, even with a Root Directory set ("For a root directory of
`/app`, `/app/**.js`"). Same source. A leading `/` anchors to the repo root (gitignore semantics; examples
`/src/**/*.ts`, `/*.go`). https://git-scm.com/docs/gitignore#_pattern_format
8.4 With watch paths, empty commits do not redeploy; use `Deploy Latest Commit` (Cmd+K).
https://docs.railway.com/deployments/github-autodeploys#autodeploy-enabled-but-no-deployment-triggered

## 9. Dockerfile builds

9.1 Uses a file named exactly `Dockerfile` at the root of the source directory; otherwise
`RAILWAY_DOCKERFILE_PATH` (default `Dockerfile`; examples `Dockerfile.origin`, `/build/Dockerfile`).
https://docs.railway.com/builds/dockerfiles ; https://docs.railway.com/variables/reference#user-provided-configuration-variables
9.2 Root Directory defaults to `/`; "all build and deploy commands will operate within the defined root
directory"; with a root directory Railway "will only pull down files from that directory".
https://docs.railway.com/builds/build-configuration#set-the-root-directory ; https://docs.railway.com/deployments/monorepo#deploying-an-isolated-monorepo
Build context = Root Directory is still implied, not stated `[TODO verify]` (first deploy of
`RAILWAY_DOCKERFILE_PATH=relay-server/Dockerfile` with Root Directory `/`).
9.3 `.dockerignore`: mentioned only as advice ("Exclude unnecessary files with `.dockerignore`"), no spec of
location (context root assumed). https://docs.railway.com/deployments/troubleshooting/slow-deployments#large-container-images
9.4 Build-time vars only via `ARG` in the stage; cache mounts `--mount=type=cache,id=s/<service id>-<path>,target=<path>`.
https://docs.railway.com/builds/dockerfiles . BuildKit is not named anywhere in the docs (docs search for "BuildKit"
returns nothing) `[TODO verify]`; cache-mount support implies it. Layer cache not guaranteed; `NO_CACHE=1` disables it.
https://docs.railway.com/builds/build-configuration#why-isnt-my-build-using-cache

## 10. Wait for CI

10.1 Service setting **`Wait for CI`**: Railway waits for GitHub Actions before deploying a commit. Toggle appears
only if the repo has a workflow that runs `on: push` for the trigger branch (e.g. `main`), and the updated
Railway GitHub App permissions are accepted. https://docs.railway.com/deployments/github-autodeploys#wait-for-ci
10.2 Behaviour: deployment sits in `WAITING` until every GitHub Actions check suite on the commit finishes;
judged per workflow run, not per job; other GitHub apps' checks ignored. Failed workflow → deployment skipped;
skipped/neutral → never blocks; cancelled → blocks only if no other workflow on the commit succeeded; not all
finished after 2 h → skipped. https://docs.railway.com/deployments/github-autodeploys#enabling-wait-for-ci
10.3 Consequence for this repo: CI must run on `push` to `main` (not only `pull_request`), and must not use a
concurrency group that cancels runs if we rely on the gate (a cancelled run can be ignored when another passes).
Same source ("Keep that workflow out of any concurrency group that cancels queued runs"); the guide confirms
the workflow must run on push to the trigger branch: https://railway.com/guides/ship-on-merge-pr-canaries#step-3-gate-the-merge-deploy-with-wait-for-ci

## 11. GitHub autodeploy

11.1 Services linked to a repo deploy automatically on every push to the connected (trigger) branch; branch set
in Service Settings. https://docs.railway.com/deployments/github-autodeploys
11.2 Per service: **Disable** (stops autodeploy) / **Enable** in the same settings section; manual deploy via
Cmd+K → `Deploy Latest Commit`. Exact setting label beyond the Disable/Enable button is not given `[TODO verify]`.
https://docs.railway.com/deployments/github-autodeploys#disable-automatic-deployments
11.3 Autodeploy needs a project member with a connected GitHub account and contributor access.
https://docs.railway.com/deployments/github-autodeploys#requirements-for-autodeploy
11.4 Watch paths (§8) further filter which pushes deploy.

## 12. Privacy, DPA, data residency

12.1 Railway publishes a standard DPA (GDPR Art. 28) at https://railway.com/legal/dpa with a self-service DocuSign
link. https://docs.railway.com/enterprise/compliance#gdpr-compliance---data-processing-agreement-dpa
12.2 Sub-processor list: https://trust.railway.com/item/subprocessors (DPA §6; ≥10 days email notice of new
sub-processors). https://railway.com/legal/dpa . The public page rendered only a few names (e.g. Cloudflare,
Stripe) `[TODO verify]` full list in a browser.
12.3 Residency: DPA §9.1 says Railway may transfer personal data outside the EEA/UK/CH, its "primary processing
operations take place in the United States", and it "may provide options for certain local data storage" for
paid services; per §9.2–9.5 (not §9.1) ex-EEA/UK/CH transfers rely on the Data Privacy Framework (where the
recipient is certified) or the EU SCCs (UK: UK Addendum; CH: modified EU SCCs). https://railway.com/legal/dpa
Choosing EU West places compute in Amsterdam (§7) but is not an EU-residency guarantee for logs/metadata
`[TODO verify]`.
12.4 SOC 2 Type II / SOC 3; HIPAA BAA only as a paid add-on; Trust Center https://trust.railway.com.
https://docs.railway.com/enterprise/compliance

## Open / [TODO verify]

1. HTTP logs: does `path` include the query string? (test after first deploy; §5.4)
2. Build context = Root Directory; `.dockerignore` location; BuildKit (§9.2–9.4).
3. Hobby can pick EU West (Amsterdam) in the region picker (§7.4).
4. IaC region key: `europe-west4` vs `europe-west4-drams3a` (§7.3).
5. Generated `*.up.railway.app` domain survives adding a custom domain and is removed only by an explicit delete (§3.9).
6. Exact label of the autodeploy toggle in service settings (§11.2).
7. Full sub-processor list and where logs/metrics are stored for EU-region services (§12.2–12.3).
8. (Resolved 2026-11-02: per-service caps include replica multiplication; single replica = 8 vCPU / 8 GB on Hobby, §4.7.)

## Sources

- https://docs.railway.com/deployments/healthchecks
- https://railway.com/guides/roll-back-bad-deploy (docs.railway.com/guides/… redirects here, HTTP 308)
- https://docs.railway.com/variables/reference
- https://docs.railway.com/deployments/reference
- https://docs.railway.com/deployments/restart-policy
- https://docs.railway.com/deployments/troubleshooting/slow-deployments
- https://docs.railway.com/networking/domains/working-with-domains
- https://docs.railway.com/networking/troubleshooting/ssl
- https://docs.railway.com/cli/domain
- https://docs.railway.com/pricing/cost-control
- https://docs.railway.com/pricing/plans
- https://railway.com/pricing
- https://docs.railway.com/observability
- https://docs.railway.com/observability/logs
- https://docs.railway.com/cli/logs
- https://docs.railway.com/observability/metrics
- https://docs.railway.com/deployments/regions
- https://docs.railway.com/deployments/optimize-performance
- https://docs.railway.com/overview/advanced-concepts
- https://docs.railway.com/infrastructure-as-code/reference
- https://docs.railway.com/builds/build-configuration
- https://docs.railway.com/deployments/monorepo
- https://docs.railway.com/builds/dockerfiles
- https://docs.railway.com/deployments/github-autodeploys
- https://railway.com/guides/ship-on-merge-pr-canaries
- https://docs.railway.com/config-as-code/reference
- https://docs.railway.com/enterprise/compliance
- https://railway.com/legal/dpa
- https://trust.railway.com/item/subprocessors
- https://station.railway.com/questions/eu-support-for-hobby-plan-e32b309f (community, non-authoritative)
- https://git-scm.com/docs/gitignore#_pattern_format
