# API Contract — Code-Review Web App

**Date:** 2026-06-08 · **Status:** Authoritative — design-complete; single source of truth for the HTTP boundary.

> **Single source of truth for the HTTP boundary. Changes here first — `frontend.md` and
> `backend.md` REFERENCE this and do not re-declare wire shapes.** If a field name, status code,
> enum value, or auth requirement changes, it changes in this document first; the component docs
> cite it (backend §5/§12, frontend §14) and must not restate it. The backend additionally publishes
> the **live OpenAPI schema at `/api/openapi.json`**, which must match this document.

This document is the shared interface between the Vite + React SPA and the FastAPI service. The one
fact that shapes the whole contract: **inference is not in the API.** The LLM (Qwen2.5-Coder-1.5B) runs
entirely in the browser (WebLLM → WebGPU). The backend never sees a token, holds no LLM key, and
exposes **no inference, streaming, or model-proxy endpoint**. The browser runs a review to completion
locally, then **POSTs the finished result** to be persisted. The API covers exactly three concerns:

1. **Auth & identity** — GitHub OAuth, guest mode, session, UI-language preference.
2. **History** — persist / list / fetch / delete completed reviews and their feedback.
3. **Telemetry** — a public, fire-and-forget beacon for client-side model-health signals.

---

## 1. Conventions

| Aspect | Convention |
|---|---|
| Base path | All endpoints under **`/api`**. Caddy proxies `/api/*` → uvicorn; everything else is the SPA. |
| Origin | **Single origin → no CORS.** SPA and API share the Caddy origin. No base-URL config. |
| Versioning | Unversioned (`/api/...`) for the demo. Forward path: `/api/v1` if a breaking change ships. The backend publishes the live schema at **`/api/openapi.json`**, which must match this document. |
| Format | `application/json` request/response bodies, UTF-8. The telemetry beacon also accepts `text/plain` (the `navigator.sendBeacon` constraint, §6). |
| Casing | JSON keys are **`snake_case`** (matches the data model and the Python backend). |
| Timestamps | **ISO-8601 UTC** strings, e.g. `2026-06-08T09:30:00Z`. |
| IDs | Server-generated **UUIDv4** strings for `user.id`, `review.id` (= `session_id`), `feedback.id`. |
| Auth transport | **Session cookie only** (§2). No bearer tokens, no API keys. Cookie is `HttpOnly; Secure; SameSite=Lax`. |
| Client fetch | Browser must send `credentials: 'include'` so the cookie rides along. |
| Ownership | Every `reviews`/`feedback` resource is scoped to the authenticated principal. Cross-principal access returns **`404` (not `403`)** so the API does not confirm another principal's resource exists (§3). |
| Validation | All DTOs are Pydantic v2 with **`extra='forbid'`** — unexpected fields are rejected (`422`). |

### 1.1 Naming disambiguation (load-bearing)

- The **persisted `ReviewSession` entity** (DB table `review_session`) is serialized on the wire as
  **`Review`** — the DTOs are `ReviewCreate` / `ReviewListItem` / `ReviewDetail`. "Review" (wire) and
  "ReviewSession" (DB) are the same object; `review.id == review_session.id == session_id`.
- **`Feedback.session_id` is the FK to that review id** (`review_session.id`) — it is **NOT** the
  auth-session cookie. The two senses of "session" never overlap on the wire: the auth session is the
  `HttpOnly` cookie (never a body field); `session_id` in a body always means the parent review id.

> **Out of the wire contract:** license attribution — *Apache-2.0* (the model card) — is a **frontend
> UI requirement** (an in-app attribution surface), not an HTTP concern. It is mentioned here only to
> note that it is deliberately kept out of this contract.

---

## 2. Auth & session model

- **Mechanism:** a single **`HttpOnly; Secure; SameSite=Lax` signed session cookie** (Starlette
  `SessionMiddleware`, HMAC-signed via `itsdangerous`). The signing key is a backend secret
  (`SESSION_SIGNING_KEY`). **There is no LLM key.** One cookie, one signing key — the same cookie
  Authlib already requires for the OAuth `state`/CSRF nonce. Not a JWT (an `HttpOnly` cookie is invisible
  to JS → XSS-exfiltration resistant, and revocation is key-rotation).
  - Cookie attributes: `HttpOnly`, `Secure` (TLS-only; WebGPU secure-context), `SameSite=Lax`,
    `Path=/`, `Max-Age` 14 days. Payload is minimal: `{ user_id, is_guest }` — no PII, no secrets.
    (The per-review `client_id` is a body field on `ReviewSession`/`TelemetryEvent`, **not** in the
    cookie; `itsdangerous` carries the signing timestamp itself, so no `iat` is stored in the payload.)
    `SameSite=Lax` (not `Strict`) is **required** so the cookie is sent on the top-level
    redirect back from `github.com` (else "signed-in but appears signed-out on first load").
- **GitHub OAuth (Authlib):** scopes are **`read:user user:email`** — **NOT** "identity only." GitHub
  is **OAuth2, not OIDC**: there is no `id_token`/`userinfo` shortcut. The callback must call
  `GET /user` *and* `GET /user/emails` with the token; the verified **primary email is only available
  via `/user/emails`** (it is frequently `null` on `/user`). The `user:email` scope is therefore
  required, not optional.
- **Principal:** every authenticated request resolves to a principal that is either a **user** (GitHub
  OAuth, `is_guest=false`, real `github_id`) or a **guest** (`is_guest=true`, `github_id=null`, a
  first-class `User` row created by `POST /api/auth/guest`). Guest mode removes friction for a new visitor (no
  GitHub grant required) and has isolated history.
- **Guest isolation:** a guest sees only reviews owned by that same guest principal, enforced by the
  same owner predicate as any user (§3). No special-casing.
- **Guest → GitHub upgrade — RE-PARENT (resolved):** on a successful GitHub login *with an active guest
  session present*, the guest's owned `ReviewSession` rows are **`UPDATE`d to the new authenticated
  `user_id`**, then the now-empty guest `User` row is **deleted**. History is **preserved** across the
  upgrade (the sidebar persists). Re-parent + delete + user-upsert run in **one transaction**; on failure
  the login surfaces `db_error` and the guest data is left intact. (The frontend must adopt *re-parent*,
  not discard.)
- **CSRF:** `SameSite=Lax` + same-origin deployment is the posture; state-changing requests are
  same-origin `fetch` with the cookie. The OAuth round-trip additionally validates a signed `state`
  (Authlib). No separate CSRF token for the demo. **`POST /api/telemetry` is intentionally exempt** — it
  is public, carries no authority and no raw code (§6).

---

## 3. Error model — RFC 9457 `application/problem+json`

Every non-2xx response uses `Content-Type: application/problem+json` and carries **`detail`** and a
**`correlation_id`** (the request id, echoed so a caller can quote it when reporting an issue; full stack/SQL goes only to the
structured log under that id, never the body):

```json
{
  "type": "https://errors.app/validation",
  "title": "Unprocessable Entity",
  "status": 422,
  "detail": "code_text exceeds 262144 bytes",
  "instance": "/api/reviews",
  "correlation_id": "01J...",
  "errors": [ { "field": "code_text", "msg": "..." } ]
}
```

`errors[]` is optional and present only on `422` (field-level Pydantic validation).

| HTTP | When |
|---|---|
| `400` | Malformed request — rare; most validation is `422`. |
| `401` | No / invalid session on a `session` route (anonymous → signed-out state). |
| `404` | Resource missing **or owned by another principal** — IDOR-safe; existence is not confirmed (§1). |
| `413` | Body too large at the byte-cap layer **below** Pydantic — the 1 MB global request-body cap, or the telemetry ≤ 8 KB per-route cap. |
| `422` | Validation failure (`extra='forbid'`, enum, the 256 KB `code_text` field cap, `code_hash` mismatch, malformed cursor) — the app-layer `code_text` size cap is a Pydantic `field_validator` and so surfaces as `422`, not `413`. |
| `429` | Rate limit — scaffolded as a no-op, disabled in the demo. |
| `503` | DB write failure / `db_ok` false (the History-UI "save-failed" state). |
| `5xx` | Generic server failure (safe message only; detail in the log under `correlation_id`). |

> **No `403`** is defined: ownership failures use **`404`** so an attacker cannot enumerate ids.
> **No `409`** is defined: feedback is append-only (a re-vote is another `201`, never a conflict), and
> review create is always a fresh `201`.
> Internal causes behind the OAuth redirect (state mismatch / GitHub error / DB error) are surfaced to
> the browser only as `302 → /?auth_error=<reason>` (§5), not as status codes.

---

## 4. Endpoint summary

All same-origin under `/api`, JSON bodies, `HttpOnly` cookie auth (`credentials: 'include'`), errors as
RFC 9457 `application/problem+json` carrying `detail` + `correlation_id`. Owned-resource misses → **404,
not 403**.

| # | Method · Path | Auth | Request | Success | Notable errors |
|---|---|---|---|---|---|
| 1 | `GET /api/health` | none | — | `200 {status, db_ok, version}` | `503` if `db_ok` false |
| 2 | `GET /api/auth/me` | session | — | `200 MeResponse` | `401` anonymous |
| 3 | `GET /api/auth/github/login` | none | — (redirect) | `302` → GitHub authorize URL | `503` OAuth misconfig |
| 4 | `GET /api/auth/github/callback?code&state` | none | query (`state` backend-owned, opaque to SPA) | `302` → `/` + sets cookie | failures → `302 → /?auth_error=<reason>` |
| 5 | `POST /api/auth/guest` | none | — | `201 MeResponse` new guest · `200 MeResponse` reuse/already-authed (+ guest cookie) | `503` DB insert |
| 6 | `PATCH /api/auth/me` | session | `ProfileUpdate` | `200 MeResponse` | `422`; `503` |
| 7 | `POST /api/auth/logout` | session | — | `204`, clears cookie | — |
| 8 | `GET /api/reviews?limit&cursor` | session | query (keyset cursor) | `200 ReviewListPage` | `422` malformed cursor |
| 9 | `GET /api/reviews/{id}` | session | — | `200 ReviewDetail` | `404` not-found/not-owned |
| 10 | `POST /api/reviews` | session | `ReviewCreate` | `201 ReviewDetail` | `413`; `422`; `503` |
| 11 | `DELETE /api/reviews/{id}` | session | — | `204` | `404` not-found/not-owned |
| 12 | `POST /api/feedback` | session | `FeedbackCreate` | `201 FeedbackResponse` | `404` session not owned; `422`; `503` |
| 13 | `POST /api/telemetry` | **none** | `TelemetryBeacon` | `202` (fire-and-forget) | `413`; `422`; `503` |
| 14 | `GET /api/metrics` | bearer token (prod) / none (dev) | — | `200 text/plain` (Prometheus exposition) | `401` missing/wrong token (prod only) |

**Enums the frontend must mirror:** `review_mode ∈ {explain, bugs, security, style}` ·
`rating ∈ {up, down}` · `reason_tags ⊆ {inaccurate, too_vague, wrong_language, hallucinated}`.

---

## 5. Per-endpoint detail

### 5.1 `GET /api/health` — auth `none`

Liveness + DB ping. `db_ok` runs a trivial `SELECT 1`.

```json
{ "status": "ok", "db_ok": true, "version": "1.0.0" }
```
On DB failure → `503` with `{ "status": "degraded", "db_ok": false, "version": "..." }`.

### 5.2 Auth

#### `GET /api/auth/me` — auth `session` → `200 MeResponse`

```json
{
  "id": "uuid",
  "is_guest": false,
  "display_name": "octocat",
  "email": "octocat@example.com",
  "ui_language": "ja",
  "telemetry_opt_out": false
}
```
- Guests: `is_guest: true`, `display_name: "Guest"`, `email: null`.
- `ui_language ∈ {"en", "ja", null}` — `null` = not yet chosen → SPA restores from localStorage /
  browser default; a non-null value lets a signed-in user's UI language survive a device switch. This is
  the **UI-locale toggle** (per-user, profile-persisted) and is **distinct** from `ReviewSession.language`,
  which is the review-output/content language.
- `telemetry_opt_out` (boolean, default `false` — telemetry is opt-OUT) — the **server-side mirror** of
  the client's localStorage key `tako.telemetry_opt_out`, so the preference survives a device switch
  for signed-in users. Enforcement stays client-side: `lib/telemetry.ts` reads localStorage synchronously
  per beacon; on login/profile load the SPA writes this server value INTO localStorage (server wins),
  exactly like `ui_language` reconciliation.
- `401` when anonymous → the SPA renders the signed-out state. This is how the SPA learns auth state
  without a JS-readable companion cookie.

#### `GET /api/auth/github/login` — auth `none` → `302`

Redirects to the GitHub authorize URL (Authlib `authorize_redirect`); the signed `state`/CSRF nonce is
stored in the session cookie. The registered GitHub `redirect_uri` is the **backend** route
`/api/auth/github/callback` (GitHub redirects to the backend, never the SPA). Begin login by **navigating
the browser** here (a redirect flow, not `fetch`). `503` if OAuth is misconfigured.

#### `GET /api/auth/github/callback?code&state` — auth `none` → `302`

Exchanges the code (validates `state`), fetches `/user` + `/user/emails`, upserts the `User` keyed on
`github_id` (new → insert; returning → reuse the existing `id`, refresh `display_name`/`email`),
**re-parents any active guest's history** (§2), sets the session cookie, and `302 → /` (SPA root).

> **Canonical failure redirect:** because this is a browser top-level navigation (not `fetch`), failures
> are surfaced as **one** shape: **`302` to path `/` with query param `auth_error`** —
> `Location: /?auth_error=<reason>` where `reason ∈ {state_mismatch, github_error, db_error}`. Bare status
> codes are internal (logs/telemetry) only; the browser always lands on `/?auth_error=<reason>`. The SPA
> reads `auth_error` on load, shows the matching message, then strips the param. There is **no SPA
> `/auth/callback` route** in this flow.

#### `POST /api/auth/guest` — auth `none` → `201` (new guest) / `200` (reuse) `MeResponse` + guest cookie

Idempotent — the status reflects whether a row was created:
- **`201 MeResponse`** — a caller with **no/invalid** session: mint a fresh
  `User(is_guest=true, github_id=null, display_name="Guest", ui_language=null)` and set the guest cookie.
- **`200 MeResponse`** — a caller with an existing valid **guest** cookie reuses that guest `User`
  (refreshes the cookie, no new row), or an **authenticated** caller gets their own `MeResponse` unchanged.

Both cases return an identical `MeResponse` body (so the SPA populates auth state the same way regardless).
`503` on DB insert failure.

#### `PATCH /api/auth/me` — auth `session` → `200 MeResponse`

Persists per-user preferences (works for guests and authenticated users). Body **`ProfileUpdate`** —
all fields optional; **only fields actually present in the body are applied** (PATCH semantics):

```json
{ "ui_language": "en", "telemetry_opt_out": true }
```
- `ui_language` is `Literal["en", "ja"]`; an explicit `null` clears it (→ "not yet chosen"); omitting the
  field leaves it unchanged. The SPA also mirrors the value to localStorage.
- `telemetry_opt_out` is a boolean; omitting it (or sending `null`) leaves it unchanged. The SPA writes
  localStorage `tako.telemetry_opt_out` always and additionally PATCHes here for non-guest users.
- `422` on validation failure (unknown fields, non-bool `telemetry_opt_out`, locale outside the literal);
  `503` on DB write failure.

#### `POST /api/auth/logout` — auth `session` → `204`

Clears the session cookie.

### 5.3 Reviews (history CRUD — per-principal scoped)

#### `POST /api/reviews` — auth `session` → **`201 ReviewDetail`**

The client computes **every** review field locally (inference is client-side) and sends them on create.
Body **`ReviewCreate`**:

```json
{
  "code_text": "string (1..262144 bytes)",
  "filename": "main.py",
  "language": "python",
  "review_mode": "bugs",
  "model_version": "Qwen2.5-Coder-1.5B@<rev>",
  "prompt_version": "review-v3",
  "code_hash": "sha256-hex",
  "review_output": "## Summary\n...",
  "timing": {
    "load_ms": 1234, "ttft_ms": 210, "total_ms": 4200,
    "tokens_prompt": 512, "tokens_completion": 256, "tok_per_sec": 38.0
  },
  "client_id": "uuid",
  "device_class": "string"
}
```
- **Required:** `code_text`, `language`, `review_mode`, `model_version`, `prompt_version`, `code_hash`,
  `review_output`, `timing`. **Optional (nullable):** `filename`, `client_id`, `device_class`.
- `review_mode` is `Literal["explain", "bugs", "security", "style"]`. `code_text` is
  `min_length=1`, capped at **262144 bytes** (256 KB; the cap is on the UTF-8-encoded byte length, not
  the code-point count, so multibyte JP source is measured fairly). The cap is a Pydantic
  `field_validator`, so an over-cap `code_text` is rejected **`422`** (matching the §3 example). `413` is
  reserved for the byte-cap layer below Pydantic — a request body over the 1 MB global cap (§10.2-equivalent).
- The server **recomputes `code_hash` from `code_text` and rejects a mismatch (`422`)** — client hashes are
  not trusted for integrity. (Contrast: on telemetry, `code_hash` is an opaque, unverified correlation key.)
- **Detail `title` is server-computed at write time** and stored: `title = (filename if provided, else the
  first non-blank line of code_text), truncated to 120 chars`. This is the **`ReviewDetail.title`** field.
- The **sidebar list fields are also materialized at write time** into their own stored columns — `list_header`
  (def/class-aware label, line-number-stripped, ≤48 chars), `snippet` (cleaned first code line, ≤80 chars),
  `code_bytes`, `line_count` — computed once from `code_text` alongside `code_hash`. The list path reads ONLY
  these small columns and **never** loads `code_text` / `review_output`. See the forked-`title` note under
  `GET /api/reviews`.
- **Response is the FULL record (`201 ReviewDetail`)**, not `{id, created_at}`. It includes the
  server-assigned `id` (`== session_id`, which enables feedback), `user_id`, `created_at`, the
  server-computed `title`, and the `feedback` field (`null` on create). Returning the full record lets the
  SPA restore the result pane immediately.
- On DB write failure → `503` (the **save-failed** state the History UI renders; the SPA keeps the rendered
  review and offers retry).

> **Invariant:** `model_version` **and** `prompt_version` are **required** on every create — they are the
> OODA / A-B substrate. Reject with `422` if absent.

**`ReviewDetail`** (get / create response — full record):

```json
{
  "id": "uuid",
  "user_id": "uuid",
  "created_at": "2026-06-08T09:30:00Z",
  "title": "main.py",
  "language": "python",
  "review_mode": "bugs",
  "model_version": "Qwen2.5-Coder-1.5B@<rev>",
  "prompt_version": "review-v3",
  "code_text": "1  def f(x):\n2    return x/0\n",
  "code_hash": "sha256-hex",
  "review_output": "## Summary\n...",
  "timing": { "load_ms": 0, "ttft_ms": 410, "total_ms": 4200,
              "tokens_prompt": 320, "tokens_completion": 180, "tok_per_sec": 38.0 },
  "client_id": "uuid",
  "device_class": "webgpu;vendor=apple;mem=high;chrome",
  "feedback": { "rating": "up", "reason_tags": ["too_vague"] }
}
```
- `language` is the review/content language (NOT the UI locale, §5.2). `code_text` is line-numbered input
  and is stored **only** here. `review_output` is markdown, stored opaque and sanitized client-side on render.
- `feedback` is the **current** feedback for the review — the row with `MAX(created_at)`, tie-broken by
  `MAX(id)` — or `null` when never rated. (Feedback is append-only, so "current" is always the latest append.)

**`timing` field names/units:** produced client-side by a `mapUsage()` helper converting WebLLM
`usage.extra` **seconds** → wire **milliseconds** (see `frontend.md` "Timing"). `load_ms` is measured
separately (it is `0` on a warm/cached engine).

#### `GET /api/reviews?limit&cursor` — auth `session` → `200 ReviewListPage`

Keyset (cursor) pagination over the composite `(user_id, created_at DESC)` index. The list query uses a
**genuinely lightweight projection**: it `SELECT`s only the base fields + the write-time-materialized
list columns (`load_only`), so it **never** loads `code_text` (≤256 KB) or `review_output` — a 100-row
page reads only small columns, not ~25 MB of payloads.

**`ReviewListItem`:**
```json
{ "id": "uuid", "title": "add_values", "review_mode": "bugs",
  "language": "python", "created_at": "2026-06-08T12:00:00Z",
  "snippet": "def add_values(foo, bar):", "code_bytes": 1234, "line_count": 18 }
```
- The SPA composes the display label as `title · review_mode`; `snippet` is the secondary line, and
  `code_bytes` / `line_count` drive the sidebar's size/length affordances.

> **Forked `title` semantics (intentional, by field name).** `ReviewListItem.title` is **not** the same
> derivation as `ReviewDetail.title`. The list `title` is the **def/class-aware header** (`list_header`
> column: first `def`/`class` name, else first non-blank line, with leading editor line-numbers stripped,
> ≤48 chars) — chosen because the sidebar wants the *symbol* under review, not a filename. The detail
> `title` is the **filename-or-first-line** label (`title` column, ≤120 chars, verbatim). Both are stored
> columns materialized at write time; the list path reads `list_header`, the detail path reads `title`.

**`ReviewListPage`:**
```json
{ "items": [ /* ReviewListItem, ... */ ], "next_cursor": "opaque-base64url|null" }
```
- **Cursor encoding:** `next_cursor = base64url("<created_at_iso>|<id>")` of the **last returned row**.
  Unsigned / non-secret — it encodes only a keyset position and leaks nothing cross-user because the query
  is always owner-scoped. A tampered cursor can at most page within the caller's own rows. The query is
  `WHERE user_id=:me AND (created_at, id) < (:c_created_at, :c_id) ORDER BY created_at DESC, id DESC LIMIT :limit`.
- **Malformed/undecodable cursor → `422`.** A **valid-but-exhausted** cursor → normal `200` with
  `{"items": [], "next_cursor": null}`.
- **Empty history** (no rows) → `200 {"items": [], "next_cursor": null}` — the History-UI **empty-state**
  trigger.
- `limit` default 20, max 100. `next_cursor: null` on the final page.

#### `GET /api/reviews/{id}` — auth `session` → `200 ReviewDetail`

Full record (with embedded `feedback`). `404` if missing or not owned.

#### `DELETE /api/reviews/{id}` — auth `session` → `204`

`404` if missing or not owned (idempotent toward foreign/missing ids).

### 5.4 Feedback

#### `POST /api/feedback` — auth `session` → `201 FeedbackResponse`

Body **`FeedbackCreate`**:
```json
{ "session_id": "uuid", "rating": "up", "reason_tags": ["too_vague"] }
```
- `session_id` is the **parent review id** (`== ReviewDetail.id`), **not** the auth-session cookie (§1.1).
- `rating` is `Literal["up", "down"]`. `reason_tags` is validated against the closed whitelist
  `{inaccurate, too_vague, wrong_language, hallucinated}`: **≤ 4 distinct values, all from the whitelist** —
  duplicates and unknown values → `422`.
- **Append-only:** posting feedback on an already-rated review **inserts a new row** (the re-vote 👍→👎 /
  tag-edit case); the server never updates or rejects, and there is no `409`. The "current" feedback in
  `ReviewDetail.feedback` is the latest append (`MAX(created_at)`, tie-break `MAX(id)`).
- **Ownership:** the referenced `session_id` must belong to the caller (resolved via
  `session_id → review_session.user_id`), else `404`. `503` on DB write failure.

**`FeedbackResponse`** (`201`):
```json
{ "id": "uuid", "session_id": "uuid", "rating": "up", "created_at": "2026-06-08T12:05:00Z" }
```

### 5.5 Telemetry beacon

#### `POST /api/telemetry` — auth **`none`** → **`202`**

> **Auth resolution (RESOLVED — `auth='none'`):** telemetry ingestion is **public, anonymous, and
> FK-decoupled** from `User`. It **must fire on the pre-sign-in path** — e.g. a `webgpu_probe` or
> `model_load` failure on a visitor who never establishes even a guest session — which is exactly the
> north-star funnel signal the product wants. Requiring a session would force the SPA to mint a guest
> `User` first, dropping precisely the visitors whose capability/load failures matter most. The
> `telemetry_event` table carries **no FK to `User`**; only the anonymous `client_id` stitches events, so
> dropping the session requirement changes no ownership or isolation property. **The cookie, if present, is
> ignored on this route.** Do **not** call `POST /api/auth/guest` just to emit a beacon.

Designed for `navigator.sendBeacon` → also accepts a `text/plain` body containing JSON. **Success is
`202 Accepted`** (fire-and-forget; `sendBeacon` does not expose the status to the client). **Per-beacon
hard cap: ≤ 8 KB** (distinct from and below the 1 MB global body cap) → over = `413`. `extra='forbid'`.

**`TelemetryBeacon`:**
```json
{
  "event": "model_load",
  "client_id": "uuid",
  "code_hash": "sha256-hex|null",
  "webgpu_supported": true,
  "device_class": "string|null",
  "browser": "string|null",
  "metrics": {
    "ok": true,
    "load_ms": 1234,
    "ttft_ms": 210,
    "tok_per_sec": 38.0,
    "total_ms": 4200,
    "cache_hit": true,
    "chunks": 3,
    "stage": null
  },
  "error_kind": "no_webgpu|no_adapter|device_lost|oom|generation|cdn|quota|other|cancelled|null",
  "ts": "2026-06-08T12:00:00Z"
}
```
- `event ∈ {model_load, generation, webgpu_probe, funnel_stage, error}`. `ts` is client-reported and
  untrusted.
- **`metrics` is the closed `BeaconMetrics` shape** (`extra='forbid'`): `ok` (required, bool) plus the
  optional fields `load_ms`/`ttft_ms`/`tok_per_sec`/`total_ms` (numbers), `cache_hit` (bool — warm vs
  cold model load; omitted/`null` is exposed as `cache_hit="unknown"` in metrics), `chunks` (int,
  **1–64** — chunks attempted on a chunked generation), and `stage` (closed allowlist: **`"visit"`**
  only).
- **`metrics.stage` is only valid when `event="funnel_stage"`** — on any other event it is `422`. An
  off-allowlist `stage` value is also `422`. `funnel_stage` beacons with `metrics.stage="visit"` feed
  the `visit` stage of `tako_funnel_events`.
- **`error_kind` enum (closed):** `no_webgpu|no_adapter|device_lost|oom|generation` (capability/runtime
  failures), `cdn|quota|other` (model-download failure causes on `ok:false` `model_load` beacons), and
  `cancelled` (user cancel of a load or generation — counted as `tako_model_load_cancelled` /
  `tako_generation_cancelled`, **never** as a failure or error in metrics).
- **`code_hash` is an opaque correlation key only — never verified** (the path carries no `code_text`, so
  there is nothing to recompute; contrast `POST /api/reviews`).
- **Shared producers:** the `metrics` fields (`load_ms`, `ttft_ms`, `tok_per_sec`) come from the **same
  `mapUsage()`** converter as the review `timing` object (frontend doc "Timing"), so badge and beacon never
  drift.
- **Secure-context (HTTPS) probe:** a secure-context (HTTPS) capability failure is beaconed as
  `event="webgpu_probe"`, `webgpu_supported=false`, `error_kind=null` (the `error_kind` enum has **no HTTPS
  value** by design).
- **`model_version` / `prompt_version` are EXCLUDED from the beacon** — they would trip `extra='forbid'`.
  They are review-create-only fields (§5.3).
- **Hard invariant:** the telemetry endpoint **must never store raw code** — metadata + `code_hash` only.
  `extra='forbid'` rejects a stray `code_text` field (`422`); as defense-in-depth, the service also **drops
  any code-like field and still returns `202`**. Raw `code_text` lives **only** in the history DB via
  `POST /api/reviews`. Tested on both sides.
- Honors `telemetry_opt_out`: the client sends nothing when opted out, and the server drops anything that
  arrives. `503` only if the synchronous INSERT itself fails (still swallowed client-side).

---

## 6. Cross-cutting invariants

1. **No inference, no streaming, no LLM key** on the server. There is no `/api/generate` or model proxy.
2. **Raw code lives only in `POST /api/reviews` → the history DB** (one `code_text` column). Telemetry,
   logs, and error bodies carry **metadata + `code_hash` only**, never raw code.
3. **`model_version` + `prompt_version` are required on every review create** (the OODA / A-B substrate) →
   `422` if absent; they are **excluded** from the telemetry beacon (`extra='forbid'`).
4. **`POST /api/telemetry` is `auth='none'`** — public, anonymous, FK-decoupled, fires on the pre-sign-in
   path; success is **`202`**.
5. **`POST /api/reviews` returns `201 ReviewDetail`** — the FULL record (`id == session_id`, server-computed
   `title`, `feedback`), not `{id, created_at}`.
6. **Guest → GitHub upgrade re-parents** guest `ReviewSession` rows to the new `user_id` and deletes the
   guest `User` row, in one transaction; history is preserved.
7. **Ownership scoping:** foreign/missing owned resources → **`404`, not `403`** (IDOR-safe; no id
   enumeration); the owner predicate is folded into the query (never fetch-then-check).
8. **Feedback is append-only** — a re-vote is another `201` (latest wins), never `409`.
9. **Naming:** the persisted `ReviewSession` is the wire `Review`; `Feedback.session_id` is the FK to the
   review id, never the auth-session cookie.
10. **Closed enums** for `review_mode`, `rating`, `reason_tags` (and the telemetry `event` / `error_kind`,
    and the auth-redirect `auth_error` reasons); `extra='forbid'` on every request DTO.
11. **`snake_case` JSON, ISO-8601 UTC, UUID ids, single origin / no CORS,
    `HttpOnly; Secure; SameSite=Lax` cookie, `credentials: 'include'`.**
12. Errors are uniform **RFC 9457 `application/problem+json`** carrying `detail` + `correlation_id`. The
    live OpenAPI schema at **`/api/openapi.json`** must match this document.

Any change to these invariants is a change to **this document** and must be reflected in `backend.md`
(§5/§12) and `frontend.md` (§14), which reference — and do not restate — the shapes above.
