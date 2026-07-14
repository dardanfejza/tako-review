# Enterprise CD — implementation notes

**Date:** 2026-06-12 · **Status:** **SUPPLEMENTARY DEPTH for [`enterprise-cd.md`](./enterprise-cd.md)
— read that first.** Same status as the main doc: **PATTERN, NOT THE DEPLOYED SYSTEM** — nothing in
this document is built. The running system is a single DigitalOcean droplet (systemd + rsync
deploys), documented in [`deploy-digitalocean.md`](./deploy-digitalocean.md) and operated via
[`../runbooks/operations.md`](../runbooks/operations.md). If those documents and this one disagree
about reality, they win.

**What this answers.** *If this app lived in an enterprise platform, how would a merged PR become the
running backend — and what separates the app, today, from that system?* Part 1 describes the target
system as if it already exists, by following one merge to production. Part 2 is the gap analysis for
this codebase, item by item, each with its adoption trigger. Part 3 sketches what a full enterprise
platform adds beyond the pipeline. Appendix A is the staged adoption ladder for this repo.

**Voice.** Cloud-neutral. Sections name the *pattern*; products appear in implementation tables
(Argo CD/Flux, ECR/Harbor/Artifactory, RDS/Cloud SQL/DO Managed PG, …). No cloud is the protagonist;
the existing AWS↔DO mapping convention lives in `deploy-digitalocean.md` and is unchanged.

---

## 0. The cast

| Component | Job | Typical implementations | This repo today |
|---|---|---|---|
| App repo + CI | Gate merges; turn a commit into a tested artifact | GitHub Actions, GitLab CI, Jenkins, Buildkite | `.github/workflows/ci.yml` — tests/lint only, no artifact |
| OCI image registry | Store of record for deployable artifacts | ECR, Artifact Registry, ACR, Harbor, JFrog Artifactory, GHCR, DOCR | none (images built locally for the Docker dev harness) |
| Config repo | Versioned desired state per environment | plain manifests, Helm values, Kustomize overlays | none (desired state = runbook prose) |
| GitOps operator | Reconcile cluster ⇄ config repo, continuously | Argo CD, Flux | none (deploys = `rsync` + `systemctl restart`, RB-2/RB-3) |
| Orchestrator | Run/replace containers behind probes, declaratively | EKS, GKE, AKS, DOKS, OpenShift | systemd unit `sakana-backend`, one uvicorn process |
| Secret manager | Central, audited, rotatable secrets | Vault, AWS/GCP/Azure secret managers + External Secrets Operator / CSI driver | `/srv/app/secrets.env` (0600, hand-placed, RB-4) |
| Observability | Metrics/logs/traces + deploy markers | kube-prometheus-stack, managed Prometheus, Datadog; Loki/cloud logging | host Prometheus + Grafana, file-provisioned from `infra/monitoring/grafana/` |

```
  app repo --- PR + required checks ---> merge to main
                                           |
                                           v
                            CI: test -> build image -> push
                                           |
                                           v
                     OCI registry   (immutable tag sha-<gitsha>; content-addressed digest)
                                           |
                         CI final step: one-line commit bumping the tag
                                           |
                                           v
  config repo  (desired state: manifests / values, per environment)
       ^                                   |
       |        watch + reconcile (PULL — cluster credentials never leave the cluster)
       |                                   v
  rollback = git revert         GitOps operator --- apply ---> orchestrator:
                                                    Deployment -> new ReplicaSet -> rolling update,
                                                    readiness-gated traffic, drain old pods
                                                                |
                                                                v
                                          observability: golden signals + deploy markers
```

---

## Part 1 — The target system: follow the merge

One PR merges. Trace it to production.

### 1.1 Merge gates

Trunk-based development against a protected main branch: no direct pushes, required reviews, and
required status checks — exactly the jobs `ci.yml` already runs (backend ruff + pytest with a 92%
coverage gate; frontend tsc + eslint + vitest with coverage thresholds). At team scale a merge queue
(GitHub merge queue, Bors-style) re-tests each PR against the head of main so main is *always* green.

The load-bearing property: **merging to main is the only path to production, and main is always
releasable.** This repo already has the checks; what it lacks is the enforcement half (branch
protection — today work lands on `init` by direct push).

### 1.2 Build

The merge — and only the merge, not every push — triggers an image build appended to the existing
test workflow:

- **Hermetic:** multi-stage Dockerfile, base image pinned (enterprises pin by digest, not tag),
  dependencies hash-pinned — `backend/Dockerfile` already does `pip install --require-hashes` and
  runs as non-root uid 10001; both carry over unchanged.
- **Labeled:** OCI labels record provenance (`org.opencontainers.image.revision=<git sha>`), so any
  running container can be traced to its commit.
- **No secrets at build time.** Anything the app needs arrives at *run* time (§2.3).
- **Cached:** the dependency layer is keyed on the lockfile and rebuilds only when it changes
  (registry-backed `cache-from`/`cache-to`, or the CI provider's cache).

On the "image builds in CI are expensive" worry: this image is `python:3.12-slim` plus wheels — a
warm build is on the order of one or two minutes. The expensive reputation comes from uncached
monorepo or GPU images. Locked-down enterprises that forbid Docker-in-CI run in-cluster builders
(BuildKit, Kaniko) instead; the pipeline shape is identical.

The SPA is built in the same pipeline. Its artifact is a static bundle — published to a CDN/object
store, or baked into a static-server image. Same rule either way: built once, versioned, promoted.

### 1.3 Artifact & tagging

The registry is the store of record. Two rules do most of the work:

1. **Build once, promote the digest.** The *same* image (by content-addressed digest) moves through
   staging and prod. Never rebuild per environment — a rebuild is a different artifact, whatever the
   tag says.
2. **Immutable tags; `latest` is banned from production.** Every build pushes `sha-<gitsha>` (plus a
   human `vX.Y.Z` on releases), and the registry's tag-immutability setting enforces it. Why `latest`
   is banned, concretely:
   - it is not an identity — "what is running in prod right now?" has no answer;
   - rollback stops meaning anything — the "previous" deployment's spec names the same tag;
   - audit and reproducibility need a pinned digest, not a moving pointer;
   - pull-policy semantics get ambiguous (§1.4 explains why that never helps anyway).

Add a retention policy (registries grow one image per merge forever) and a vulnerability-scan hook
(Part 3). "Artifactory" in the generic sense is just this component; JFrog Artifactory and Harbor are
the common self-hosted picks, ECR/Artifact Registry/ACR the cloud-native ones, GHCR/DOCR the hosted
budget ones.

### 1.4 The deploy trigger

**No orchestrator watches the registry.** Pushing `sha-a81b3e7` — or overwriting `latest` — changes
nothing in any cluster. `imagePullPolicy: Always` is consulted when a container *starts*, not when an
image appears. Something must change the orchestrator's desired state. Two families:

| | Push-based CD | Pull-based (GitOps) — enterprise default |
|---|---|---|
| Mechanism | CI's last job runs `kubectl set image` / `helm upgrade` against the cluster | An in-cluster operator (Argo CD, Flux) continuously reconciles the cluster to a **config repo**; CI's last act is a one-line commit bumping the image tag |
| Credentials | CI runners hold cluster credentials — the biggest secret blast radius in the org | Cluster credentials never leave the cluster; CI only needs write access to a git repo |
| Audit | Scattered across CI run logs | `git log` of the config repo *is* the deploy history — who, what, when, diff |
| Drift (someone `kubectl edit`s prod) | Invisible until the next deploy stomps it | Detected and (optionally) auto-reverted continuously |
| Rollback | Re-run an old pipeline and hope | `git revert` the bump commit — same machinery as a deploy |

The config repo is **separate from the app repo**: deploys have a different cadence than commits,
different RBAC (who may ship ≠ who may code), and a tag-bump commit must not re-trigger the app
build. The bump commit looks like this — this diff *is* the deploy:

```diff
 # config-repo/apps/review-backend/values-prod.yaml
 image:
   repository: registry.example.com/tako/review-backend
-  tag: sha-9f2c1d4
+  tag: sha-a81b3e7
```

Registry-watching *does* exist (Argo CD Image Updater, Flux image automation) — but as an opt-in
component that watches the registry and **writes the bump commit for you**. The cluster still follows
git only, so the audit trail survives.

> **A deploy is a git commit, not an image push.**

### 1.5 Rollout mechanics — "the rest"

What the orchestrator does once the operator applies the new pod template:

1. **Rolling update.** The Deployment controller creates a new ReplicaSet next to the old one and
   walks replicas across per `maxSurge`/`maxUnavailable` (defaults 25%/25%). Note for §1.6 and §2.1:
   even with `replicas: 1`, the default surge runs **one old and one new pod simultaneously**.
2. **Readiness gates traffic.** A pod joins the Service's endpoints only when its readiness probe
   passes (ours maps to `GET /api/health`). Nuance: `/api/health` checks `db_ok`, which is right for
   "don't route to a pod that can't serve" but means a shared-DB outage ejects *every* pod at once —
   mature shops split a shallow liveness endpoint from a deeper readiness one.
3. **Liveness restarts wedged containers** — and must *not* check the DB, or a DB blip becomes a
   restart storm. The `HEALTHCHECK` in our Dockerfile is ignored by Kubernetes; probes live in
   manifests.
4. **Drain.** An old pod is removed from endpoints, then SIGTERM'd, with `preStop`/termination grace
   for in-flight requests. Our CMD `exec`s uvicorn as PID 1, so SIGTERM actually reaches it — that
   detail carries over.
5. **Stall safety.** If readiness never passes, the old ReplicaSet keeps serving and
   `progressDeadlineSeconds` (default 600s) marks the rollout failed — an alert fires and traffic
   never moved. **The failure mode of a bad deploy is "nothing happened," not an outage.** A
   `latest`-pull scheme gives you the opposite.
6. **Rollback** = revert the config-repo commit (§1.4). `kubectl rollout undo` exists but is an
   anti-pattern under GitOps: the operator sees the drift and re-applies git — with self-heal on, it
   reverts your revert.

Supporting cast, one line each: PodDisruptionBudgets bound voluntary disruption during node drains;
resource requests/limits make scheduling and OOM behavior deterministic; HPA adds replicas under load
(relevant the day this deliberately-thin backend has load).

### 1.6 Database migrations under rolling updates

Our image currently runs `alembic upgrade head && exec uvicorn` at boot. Correct single-instance;
**wrong in this world**, twice:

- **The race:** N starting pods run `upgrade head` concurrently. Alembic does not serialize across
  processes by default (Postgres advisory-lock wrappers exist, but as bolt-ons).
- **The compatibility window:** §1.5 means old code serves *during and after* the migration. Every
  migration must therefore be backward-compatible for one release — the **expand–contract** (parallel
  change) discipline: ship the additive schema change first, then the code that uses it, backfill,
  and only *contract* (drop/rename) in a later release once nothing reads the old shape.

The pattern: migrations run **once, gated, before the rollout** — a pipeline step against the DB, or
a Kubernetes Job ordered ahead of the Deployment (Argo CD PreSync hook; Flux `dependsOn`), using the
*same image* with the command swapped to `["alembic", "upgrade", "head"]`. Init containers are not
the answer — they run per-pod, so the race returns. Our migrations `0001–0004` carry over verbatim;
only the invocation point moves (§2.2).

### 1.7 Deploy observability

A deploy is an *event* the monitoring stack must know about: emit a marker (Grafana annotation, Argo
notification) so every graph carries "deploy happened here"; expose a `build_info`-style metric
labeled with the git SHA (our `/api/health` already returns `version` — promote it to a metric
label); watch the golden signals split by version for the minutes after rollout; alert on the
error-rate delta. This is manual canary analysis — Part 3 automates it. Our dashboards and alert
rules are already file-provisioned from `infra/monitoring/grafana/` — that is the
observability-as-code pattern, and it ports as-is.

---

## Part 2 — The gap: this app vs. that system

Each item: current state → target state → why → **adoption trigger**, mirroring the repo's
"documented trigger to migrate" convention. Ordering is by hardness; 2.1 gates everything.

### 2.1 SQLite → managed Postgres — *the* blocker

- **Current:** SQLite (WAL) on a single-attach block volume; exactly one uvicorn process is allowed
  to exist (`backend.md` §2.1); SQLite-only engine listeners (PRAGMA setup; the `BEGIN IMMEDIATE`
  listener added after the 2026-06-11 `SQLITE_BUSY_SNAPSHOT` prod 503, `backend.md` §7.2).
- **Target:** managed Postgres (RDS / Cloud SQL / DO Managed PG) + connection pooling. SQLAlchemy
  and Alembic carry over; the SQLite-only listeners are deleted (`backend.md` §7.4 documents exactly
  this swap).
- **Why:** §1.5 runs old and new pods *simultaneously by design* — two writer processes on one WAL
  file is the documented corruption scenario, so Kubernetes and single-writer SQLite are mutually
  exclusive, full stop. Even ignoring writers: a block volume attaches to one node, so pods can't
  reschedule, and network filesystems break SQLite's POSIX locking. **"Lift the container into K8s"
  is really "migrate the DB, then lift."**
- **Data move:** `alembic upgrade head` against the empty PG, one-shot row copy (data is small), a
  short maintenance window. The single most disruptive prerequisite, and the already-documented one.
- **Trigger:** the moment >1 backend instance must exist — which a K8s rolling update implies from
  day one.

### 2.2 Migrations decoupled from boot

- **Current:** the image CMD migrates, then serves (`alembic upgrade head && exec uvicorn`).
- **Target:** same image, two invocations — *serve* (uvicorn only) and *migrate* (run once as a
  gated Job/pipeline step, §1.6) — plus the expand–contract rule in the review checklist.
- **Trigger:** the same event as 2.1; they ship together.

### 2.3 Secrets

- **Current:** `/srv/app/secrets.env`, 0600, hand-placed per RB-4. The backend's **fail-closed boot**
  (refuses to start with incomplete config) is already the right behavior.
- **Target:** a central secret manager with in-cluster injection — External Secrets Operator syncing
  into Kubernetes Secrets, or a CSI driver mounting at pod start. Per-environment secrets, RBAC'd and
  audited. Rotation gets a story: rotating `SESSION_SIGNING_KEY` means a dual-key window (sign with
  new, verify with both) or accepting mass logout. Fail-closed boot stays — in K8s it becomes the
  guard that a misconfigured pod crash-loops loudly instead of serving half-configured.
- **Trigger:** first cluster deploy — or earlier, the moment a second human needs production access
  (a file on a host has no access audit).

### 2.4 Statelessness audit — already passing

Sessions are signed HttpOnly cookies (no server-side session store), the DB is the only state, and
nothing else writes to local disk — so N replicas need no sticky sessions. This is a genuine
existing win; the work is *protecting* it: any future in-process cross-request state (rate-limit
counters — today's rate limiter is a no-op scaffold, `backend.md` §16 — caches, queues) must live in
a shared store (e.g. Redis) once replicas > 1. **Trigger:** none — this is a standing review rule,
not a migration.

### 2.5 Ingress / TLS / headers

- **Current:** Caddy serves the SPA, proxies `/api` (same origin, no CORS), auto-renews Let's
  Encrypt, and carries the hardened headers — including the CSP whose `connect-src` pins the HF
  weight-shard hosts (`cas-bridge.xethub.hf.co`; losing it breaks model download in prod only, RB-8).
- **Target:** ingress controller (NGINX / Traefik / HAProxy) + cert-manager for ACME — or a cloud LB
  with managed certs. The SPA moves to CDN/object hosting or a static container behind the same
  ingress. Two invariants must survive the move: **same-origin `/api`** (the no-CORS property), and
  **HTTPS everywhere** (WebGPU requires a secure context). Security headers move to app middleware
  (portable, unit-testable) or ingress config (central) — either works, but the CSP host list is
  environment-specific, so the RB-8 HEAD-probe of the HF redirect chain becomes a pipeline check.
- **Trigger:** cluster deploy.

### 2.6 Observability

- **Current:** host Prometheus (loopback) scrapes `/api/metrics` with a bearer token; Grafana at
  `/grafana/` (anonymous view); dashboards/alerts file-provisioned from `infra/monitoring/grafana/`.
- **Target:** kube-prometheus-stack (or managed equivalent); the scrape becomes a ServiceMonitor
  with the token in a Secret; the same dashboard JSON ships via ConfigMap provisioning — the repo's
  observability-as-code discipline transfers unchanged. Logs go from journald to a cluster pipeline
  (Loki / cloud logging) **carrying the privacy rule into log policy: raw reviewed code never appears
  in logs — `code_hash` only** (`backend.md` §10.5, APPI posture).
- **Trigger:** cluster deploy.

---

## Part 3 — What full enterprise adds (sketch)

**Environments & promotion.** Dev/staging/prod as separate clusters or namespaces, each a directory
in the config repo referencing the *same digest*; promotion is a PR from one values file to the next.
Ephemeral per-PR preview environments for review.

**Progressive delivery.** Canary (Argo Rollouts, Flagger): route 5% → 25% → 100% to the new version,
gated on metric analysis, auto-rollback on regression — §1.7's manual watching, automated.
Blue-green where instant cutover/cutback matters more than gradual exposure.

**Supply-chain security.** Scan images in CI and continuously in the registry (Trivy, Grype); sign
them (cosign/Sigstore); attach SBOMs (Syft); an admission controller refuses unsigned or
critically-vulnerable images. SLSA levels name the maturity rungs.

**Governance & policy-as-code.** Least-privilege RBAC; OPA Gatekeeper / Kyverno admission policies —
e.g. a rule rejecting `:latest` turns §1.3's convention into law; default-deny NetworkPolicies;
namespace-scoped tenancy.

**DR & backups.** Velero for cluster state; Postgres PITR + cross-region replicas; stated RTO/RPO;
*scheduled restore drills* — a backup that has never been restored is a hope, not a backup. (Today's
analogue: the volume-snapshot + `sqlite3 .backup` cron, `deploy-digitalocean.md` §9.)

**Compliance & residency.** APPI: pin data to a Japan region (the platform choice *solves* the
documented Singapore-residency tradeoff), classify `ReviewSession.code_text` as the sensitive column,
audit-log access, set retention windows (`backend.md` §16 already poses the numbers question).

**SLOs & on-call.** SLIs from the golden signals, SLOs with error budgets that gate release velocity,
alert routing/escalation, and runbooks linked from every alert — `docs/runbooks/operations.md`
already exists; in this world its scenarios become alert annotations.

---

## Appendix A — Stage ladder for this repo

Each rung is adopted on its **trigger**, not on aspiration. Skipping rungs buys complexity before its
value.

**Stage 0 — today.** systemd + rsync deploys via runbooks (RB-2/RB-3); CI runs tests only; RB-7
manual verify. Costs nothing extra and fits the single-writer SQLite rule. Right while there is one
operator and demo-scale traffic.

**Stage 1 — automated artifacts + droplet CD (no K8s).** On merge, CI builds the backend image,
pushes `sha-<gitsha>` to a registry, then over SSH runs `docker compose pull && up -d` with the
pinned tag and a health-check gate; the SPA is built in CI and rsynced (RB-3, automated). Caddy stays
on the host; the container binds loopback `:8000`; **exactly one backend container** (the
single-writer rule is unchanged). Rollback = redeploy the previous tag. Deliberately *not*
`latest`+Watchtower: the bump must stay a recorded CI step. Buys most of Part 1's value — no-hands
deploys, immutable artifacts, rollback identity — at ~$0. **Trigger:** tired of RB-2/RB-3.

**Stage 2 — the K8s prerequisites (still droplet-shaped).** Managed Postgres (§2.1, deleting the
SQLite listeners), migration-as-step (§2.2), secret manager (§2.3), statelessness review rule (§2.4).
Buys: replicas become *legal* — even two droplets behind a load balancer, without K8s. **Trigger:**
a second instance is needed (HA or write contention), or SQLITE_BUSY-class incidents recur.

**Stage 3 — managed K8s + GitOps.** Config repo, operator (Argo CD/Flux), ingress + cert-manager
(§2.5), kube-prometheus (§2.6). Buys Part 1 verbatim: declarative rollouts, drift control,
audit-by-git, team RBAC. Cost floor jumps from one droplet to control plane + nodes + LB + registry
(tens of $/month). **Trigger:** multiple services, people, or environments. Given this product's
zero-server-inference-cost thesis, Stage 1 can be the permanent home until that trigger is real.
