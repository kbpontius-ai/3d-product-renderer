# 13 — API Surface

Next.js route handlers under `/api`. JSON in/out, cookie session auth, Zod-validated at the edge,
org-scoped by RLS. Long operations return a job resource; nothing blocks a request.

## Conventions

- **Auth:** `__Host-session` cookie. `401` unauthenticated, `403` unauthorized, both without hints.
- **Errors:** `{ error: { code, message, details?, requestId } }` with stable machine codes
  (`quota_exceeded`, `artwork_rejected`, `zone_constraint_violation`, `version_conflict`, …).
- **Idempotency:** `Idempotency-Key` header honored on all POSTs that create work or spend money;
  replays return the original response from `idempotency_keys`.
- **Concurrency:** design mutations send `If-Match: <version>`; mismatch → `409 version_conflict`
  with the current document so the client can rebase.
- **Pagination:** `?cursor=&limit=` (max 100), response `{ items, nextCursor }`.
- **Rate limits:** token bucket in Redis per `(route class, user, ip)`; `429` + `Retry-After`.
  Classes: auth (5/min/ip burst 10), upload (20/hour/user), render (per-org quota), read (600/min).

---

## Auth (`/api/auth/*`) — details and pseudocode in [18](18-auth-impl.md)

| Method | Path                        | Purpose                               | Notes                                           |
| ------ | --------------------------- | ------------------------------------- | ----------------------------------------------- |
| POST   | `/api/auth/login`           | Sign in                               | Enumeration-safe, rate limited, lockout backoff |
| POST   | `/api/auth/logout`          | End session                           | Also `?all=true` to revoke every session        |
| GET    | `/api/auth/session`         | Current user + org + role             | Cheap; used by the app shell                    |
| POST   | `/api/auth/invite/accept`   | Consume invite, set password          | `{token, password}` → session                   |
| GET    | `/api/auth/invite/{token}`  | Validate invite for the accept screen | Returns masked email or neutral error           |
| POST   | `/api/auth/password/forgot` | Request reset                         | Always `204`, never reveals existence           |
| POST   | `/api/auth/password/reset`  | Complete reset                        | Revokes all sessions                            |
| POST   | `/api/auth/password/change` | Change while signed in                | Requires current password                       |

## Catalog (`/api/catalog/*`)

| Method | Path                                       | Purpose                                                  |
| ------ | ------------------------------------------ | -------------------------------------------------------- |
| GET    | `/api/catalog/products`                    | List visible products (`?category=&facet.*=&q=&cursor=`) |
| GET    | `/api/catalog/products/{productKey}`       | Detail incl. variants, zones, material slots, presets    |
| GET    | `/api/catalog/variants/{variantId}/assets` | Signed URLs for LOD0/LOD1 + textures (short TTL)         |
| GET    | `/api/catalog/materials`                   | Material library visible to the org                      |
| GET    | `/api/catalog/environments`                | Studio environments + signed HDRI URLs                   |

Catalog responses are cacheable per `(orgId, packVersionSet)`; asset URLs are not cached.

## Artwork (`/api/artworks/*` implemented; `/api/artwork/*` proposal)

**Planned presigned-upload flow (not implemented):**

```http
POST /api/artwork/upload-url
{ "fileName": "logo.svg", "bytes": 184320, "contentType": "image/svg+xml", "sha256": "…" }
→ 200 { "artworkId": "…", "versionId": "…", "uploadUrl": "https://…", "headers": {…}, "expiresIn": 300 }
   409 { error: { code: "duplicate_artwork", details: { artworkId, versionId } } }   // digest already ingested
   413 { error: { code: "too_large" } }
```

| Method | Path                                             | Purpose                                                                            |
| ------ | ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| POST   | `/api/artwork/upload-url`                        | Quota + type check, reserve version, return presigned PUT                          |
| POST   | `/api/artwork/{id}/versions/{versionId}/process` | Enqueue processing (idempotent on digest)                                          |
| GET    | `/api/artwork/{id}`                              | Metadata, current version, report, signed derived-asset URLs                       |
| GET    | `/api/artwork/{id}/events`                       | **SSE**: `progress`, `ready`, `rejected`                                           |
| GET    | `/api/artwork`                                   | Library list with thumbnails and usage counts                                      |
| PATCH  | `/api/artwork/{id}`                              | Rename                                                                             |
| DELETE | `/api/artwork/{id}`                              | Soft delete; blocked (`409 in_use`) if referenced by a design unless `?force=true` |

**Implemented today** (`/api/artworks`, one round trip instead of the presigned dance):

```http
POST /api/artworks            # body: the SVG; x-artwork-name: percent-encoded file name
→ 201 { ref: { artworkId, versionId }, name, naturalSizeMm, mmPerPx, widthPx, heightPx,
        sdfRangeMm, stats, maskUrl, sourceUrl, report, createdAt }
  200 same body, when the digest was already ingested (the upload is reused, not repeated)
  422 { error: { code: "artwork_rejected", detail: <ArtworkReport> } }
  413 { error: { code: "too_large" } }

GET  /api/artworks            # active current entries, newest first, same shape
GET  /api/artworks?state=archived # archived current entries; each includes archivedAt
GET  /api/artworks/{id}/archive # { usageCount }: current saved designs across all versions
POST /api/artworks/{id}/archive # archive all versions; { archivedAt, usageCount }
DELETE /api/artworks/{id}/archive # restore artwork; { archivedAt: null, usageCount }
GET  /api/artworks/{id}       # current version of one tenant-owned artwork, same shape
PATCH /api/artworks/{id}      # { name }: shared label only; 204
DELETE /api/artworks/{id}     # soft deletion; 204, or 409 in_use if any saved design uses it
PUT /api/artworks/{id}        # whole-artwork edit
{ "versionId": "<current UUID>", "name": "leaf-mark.svg", "widthMm": 24, "heightMm": 18,
  "rotationDeg": 90, "flipX": false, "flipY": false }
→ 200 <same artwork shape, with the new version/asset URLs>
  409 { error: { code: "version_conflict", detail: "…reopen…" } }
  422 invalid input / artwork_rejected
  404 unknown, deleted or another organisation’s artwork
GET  /api/assets/{storageKey} # derived assets; `artwork/{orgId}/…` keys are checked against the session
```

`sourceUrl` serves the sanitised SVG through the same session/tenant/viewer-bound signed asset
route as masks. The browser never gets the original unsanitised input. PUT accepts a Zod-validated
name (1–200 characters), dimensions (0.01–1000 mm), rotation (−360°–360°), flips and current version
UUID. It reads the stored source itself, regenerates the assets through the existing pipeline,
then locks the artwork and compares the expected current version before adopting the edit. A
rename-only PUT retains the geometry version. An existing matching version of the same artwork
can be reused; content belonging to a different artwork is refused with 422 rather than relinked.
Prior versions and assets are retained, so pinned designs do not change. Upload/edit use the
existing artwork-upload rate limit. There is no force-delete endpoint.

**Archive policy (F-ART-13):** archive and restore are tenant-scoped, same-origin-checked and
idempotent. The archive endpoints validate UUIDs and preserve all assets. Active is the default
collection filter; invalid states return 422. `GET /api/artworks/{id}` and authorised pinned asset
reads include archived artwork. Identical archived uploads, artwork mutations and affected design
mutations/new renders return `409 archived_artwork` with a readable `error.detail` and
`error.archivedArtworks: [{ artworkId, name }]`. Design GET/list responses include the derived
`archivedArtworks` array; the immutable document does not gain an archive field. The current saved
document and incoming references are checked under the same tenant transaction lock as archive.
Delete/restore of a design retain their existing lifecycle. Existing render reads/downloads remain
available. See [34-artwork-archive.md](34-artwork-archive.md).

**Preparation API (F-ART-12):**

- `POST /api/artworks/preparation`: bounded JSON `{source?, artworkId?, versionId?, recipe?, name?}`.
  Supply a UTF-8 source or a tenant-owned current artwork/version. Returns safe source, object/group
  manifest, canonical recipe and (when requested) that recipe's prepared preview/issues. No storage
  adoption or durable draft occurs. The preview budget defaults to 120/account/minute
  (`ARTWORK_PREPARE_LIMIT`). Source is at most 5 MB; streamed JSON is capped at 8 MB.
- `PUT /api/artworks/preparation`: same shape, with a current valid recipe and name. Re-analyzes and
  compiles against original bytes, then returns the usual artwork DTO (`selectionEditable: true`).
  Returns 201 for adoption, 200 for an identical retry; stale adoption is 409. Derived SVG, masks,
  unknown IDs, incompatible repairs and unsupported features cannot be supplied as trusted output.
- `GET /api/artworks/{id}/original?versionId=…`: current tenant-owned source-backed original as a
  non-executable attachment. Legacy records report that the original is needed; foreign/deleted
  records are unknown. The generic asset route never serves `artwork-source/`.

Analysis failure returns an understandable detail plus a correction/re-export step. Invalid or
unacknowledged output cannot be saved. Source plus artwork/version can reupload a legacy original
into an explicit new version. Whole-artwork PUT composes transforms with retained recipes.
The raw-SVG POST above remains a legacy tool/API path; application upload controls use preparation.

The presigned-upload flow above is the shape to move to when files get large and processing moves to
a worker: it exists so the browser never streams megabytes through the app, and so a slow raster does
not hold a request open. Today the pipeline is fast enough to run inline, and a request that either
returns an artwork or explains why it did not is much easier to reason about.

## Designs (`/api/designs/*`)

| Method | Path                          | Purpose                                                                                                                                                                                                                                                                       |
| ------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/designs`                | `{ variantId, name? }` → creates design + v1 document with pack defaults                                                                                                                                                                                                      |
| GET    | `/api/designs`                | Dashboard list (`?cursor=&q=`)                                                                                                                                                                                                                                                |
| GET    | `/api/designs/{id}`           | `{ design, document, version, validation }` (document migrated on read)                                                                                                                                                                                                       |
| PATCH  | `/api/designs/{id}`           | Autosave: `{ document, expectedVersion, name? }`; validates before persisting, 409 with the current version if the lock is lost. (An `If-Match` ETag is the HTTP-native spelling and is worth adopting when the API goes public; a body field is what the editor uses today.) |
| POST   | `/api/designs/{id}/duplicate` | Copy design + current document                                                                                                                                                                                                                                                |
| POST   | `/api/designs/{id}/versions`  | Named snapshot (v2)                                                                                                                                                                                                                                                           |
| GET    | `/api/designs/{id}/versions`  | History                                                                                                                                                                                                                                                                       |
| POST   | `/api/designs/{id}/thumbnail` | Client uploads a preview snapshot (used in lists)                                                                                                                                                                                                                             |
| DELETE | `/api/designs/{id}`           | Soft delete (restore window)                                                                                                                                                                                                                                                  |

`PATCH` runs `validateDesign()` and returns `{ version, validation: { errors, warnings } }`.
Blocking errors reject the write — the client cannot persist an unrenderable design.

## Renders (`/api/renders/*`)

```http
POST /api/renders
Idempotency-Key: 5c1e…
{ "designId": "…", "useVersion": 12,
  "outputs": [{ "kind":"image","widthPx":2048,"heightPx":2048,"format":"png16","alpha":false,
                "camera": { "kind":"preset","presetKey":"three-quarter" } }],
  "quality": "final" }
→ 202 { "jobId":"…", "status":"queued", "specHash":"…", "costEstimateCents":42, "queuePosition":3 }
   200 { "jobId":"…", "status":"succeeded", "deduped":true, … }     // identical spec already rendered
   402 { error: { code:"quota_exceeded", details:{ limit, used, resetsAt } } }
   422 { error: { code:"design_invalid", details:{ errors:[…] } } }
```

| Method | Path                                        | Purpose                                                         |
| ------ | ------------------------------------------- | --------------------------------------------------------------- |
| POST   | `/api/renders`                              | Snapshot → RenderSpec → quota/cost check → enqueue              |
| POST   | `/api/renders/estimate`                     | Cost/time estimate without enqueuing (drives the dialog)        |
| GET    | `/api/renders/{jobId}`                      | Status, stage, progress, outputs, provenance                    |
| GET    | `/api/renders/{jobId}/events`               | **SSE**: `stage`, `progress`, `preview`, `done`, `failed`       |
| POST   | `/api/renders/{jobId}/cancel`               | Cooperative cancel; quota refunded if not substantially started |
| GET    | `/api/renders/{jobId}/outputs/{n}/download` | `302` to a short-lived signed GET, audit-logged                 |
| GET    | `/api/renders`                              | Gallery (`?designId=&status=&cursor=`)                          |
| DELETE | `/api/renders/{jobId}`                      | Delete outputs + row                                            |

### SSE event shapes

```jsonc
event: stage    data: {"jobId":"…","stage":"trace","at":"2026-08-18T10:00:00Z"}
event: progress data: {"jobId":"…","progress":0.42,"samplesDone":420,"samplesTotal":1000,"etaSec":95}
event: preview  data: {"jobId":"…","url":"https://…/preview-3.webp","sample":300}   // progressive frames
event: done     data: {"jobId":"…","outputs":[{"n":0,"kind":"image","url":"…","width":2048}]}
event: failed   data: {"jobId":"…","code":"worker_oom","message":"…","retryable":true}
```

Transport: worker → Redis pub/sub (`render:{jobId}`) → web instance → SSE. Clients reconnect with
`Last-Event-ID`; state is re-derivable from `GET /api/renders/{jobId}`, so a missed event is never
fatal.

## Organisation (`/api/org/*`, the organisation's `owner` only) — see [25](25-org-admin.md)

The organisation is always the caller's own, taken from the session; no route accepts an `orgId`.

| Method | Path                           | Purpose                                                                                                                                                                                                                                                       |
| ------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/org/invitations`         | Invite `{email, role}` (`member` or `owner` — never `staff`), or `{email, action:'resend'}` to send a fresh link with the original role (404 if nothing is outstanding). Returns `{email, delivered, notDelivered?}` — `url` only with development tooling on |
| DELETE | `/api/org/invitations?email=`  | Revoke: the link stops working and the invited placeholder account is removed. 204                                                                                                                                                                            |
| PATCH  | `/api/org/members/{id}`        | `{status:'active'\|'suspended'}` or `{role:'owner'\|'member'}`. The last owner cannot be demoted or suspended                                                                                                                                                 |
| PUT    | `/api/org/members/{id}/access` | `{packId, allowed}` — withhold a product from one member, or give it back                                                                                                                                                                                     |

## Admin (`/api/admin/*`, `staff` only, 2FA-gated)

| Method   | Path                                                            | Purpose                                                                                                                                                                                                                                                                                                                                                                                           |
| -------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST     | `/api/admin/packs/import`                                       | Upload/import a pack bundle → validate → draft                                                                                                                                                                                                                                                                                                                                                    |
| POST     | `/api/admin/packs/{id}/publish`                                 | Publish/deprecate a pack version                                                                                                                                                                                                                                                                                                                                                                  |
| GET      | `/api/admin/packs/{id}/qa`                                      | QA render results + parity report for the pack                                                                                                                                                                                                                                                                                                                                                    |
| GET      | `/api/admin/cad`                                                | Recent ingestions                                                                                                                                                                                                                                                                                                                                                                                 |
| POST     | `/api/admin/cad`                                                | Upload a CAD file and queue it. Format decided by content; body is the file, `x-file-name` names it                                                                                                                                                                                                                                                                                               |
| GET      | `/api/admin/cad/{id}`                                           | One ingestion: status, the import result once it has one, and its worker's log (`log`)                                                                                                                                                                                                                                                                                                            |
| POST     | `/api/admin/cad/{id}`                                           | `{action:'cancel'}` — a running import stops at its next heartbeat                                                                                                                                                                                                                                                                                                                                |
| POST     | `/api/admin/cad/{id}/pack`                                      | Draft a Product Pack from a finished ingestion. `dryRun` returns the manifest without writing                                                                                                                                                                                                                                                                                                     |
| GET      | `/api/admin/packs/{id}/zones`                                   | A pack's zones, variant by variant                                                                                                                                                                                                                                                                                                                                                                |
| POST     | `/api/admin/packs/{id}/zones`                                   | Add a zone to a draft: `{productKey, variantKey, zone}`. The key is made from the zone's name and returned. 409 on a published pack                                                                                                                                                                                                                                                               |
| PATCH    | `/api/admin/packs/{id}/zones`                                   | Adjust a zone's name, size, margin, constraints and finishes. `mapping` (`planar` or `conformal`) plus a valid `frame` changes flat/surface mapping; `frame` moves it, on an unused draft only (409 otherwise, and 409 while a design uses it)                                                                                                                                                                                                                                                   |
| DELETE   | `/api/admin/packs/{id}/zones?productKey&variantKey&zoneKey`     | Remove a zone from a draft. 409 on a published pack or while a design uses it                                                                                                                                                                                                                                                                                                                     |
| POST     | `/api/admin/packs/{id}/versions`                                | Copy a pack into a new draft version (next minor), zones and meshes included — or return the pack's draft version already in progress, if there is one                                                                                                                                                                                                                                            |
| CRUD     | `/api/admin/materials`, `/api/admin/environments`               | Library management                                                                                                                                                                                                                                                                                                                                                                                |
| CRUD     | `/api/admin/orgs`, `/api/admin/users`, `/api/admin/invitations` | Tenancy administration. Account `PATCH` and `DELETE /api/admin/users/:id?orgId=<uuid>` verify the account belongs to the selected organization inside the mutation transaction; omitting `orgId` preserves the existing staff API. Invitations: `POST` invites (`action: "resend"` re-sends), `DELETE ?orgId&email` revokes; the response is shaped as the owner's (below `/api/org/invitations`) |
| GET/POST | `/api/admin/queue`                                              | Global queue view; `{action:'retry-failed'}` requeues failures in bulk                                                                                                                                                                                                                                                                                                                            |
| GET/POST | `/api/admin/queue/{id}`                                         | One job with its worker's log; `{action:'retry'}` (failed or cancelled only — 409 for a job that succeeded) or `{action:'cancel'}`                                                                                                                                                                                                                                                                |
| GET      | `/api/admin/status`                                             | The System Status page's data: services, workers, live and queued work, the last 24 hours, and the server log (`?level=warn\|error&service=`)                                                                                                                                                                                                                                                     |
| GET      | `/api/admin/usage`                                              | Per-org usage, GPU minutes, failure histogram                                                                                                                                                                                                                                                                                                                                                     |
| GET | `/api/admin/packs/{id}/thumbnails` | Staff-only variant data and current Catalog preview URLs |
| PUT | `/api/admin/packs/{id}/thumbnails?variantId=<uuid>` | Staff-only viewer capture: bounded 768 × 576 PNG body, same-origin, rate-limited, validated and audited; returns `{thumbnailUrl}`. Geometry and saved designs remain unchanged |

## Internal worker API (`/api/internal/*`, mTLS or signed service token)

| Method | Path                               | Purpose                                                     |
| ------ | ---------------------------------- | ----------------------------------------------------------- |
| POST   | `/api/internal/jobs/{id}/claim`    | Worker claims a job, receives the spec + scoped credentials |
| POST   | `/api/internal/jobs/{id}/progress` | Stage/progress/preview-frame updates                        |
| POST   | `/api/internal/jobs/{id}/complete` | Output keys, timings, gpu seconds, provenance               |
| POST   | `/api/internal/jobs/{id}/fail`     | Error class + diagnostics (staff-visible only)              |

Workers never query org tables directly for anything not in the claim response, and their storage
credentials are scoped to the job's key prefixes for the job's lifetime.

## Public API (v3, `F-GEN-07`)

Same resources under `/api/v1/*` with API-key auth (`Authorization: Bearer sk_…`), per-key scopes
and rate limits, and versioned response envelopes. Designed for from day one by keeping route
handlers thin over a service layer — the internal callers use the same services.

Preparation returns 409 with a recovery hint when a new upload matches a cached version that is
no longer current. Explicit edits use the expected-version guard; identical successful retries
remain idempotent. Re-upload of deleted prepared artwork restores the matching version atomically.

## Staff product setup endpoint

`PATCH /api/admin/packs/:id/setup` requires same-origin requests and staff authorization. Body: `{productKey, variantKey, revision, orientation?, materialDefaults?}`; at least one change is required. `revision` is the server-issued 64-character SHA-256 token. Orientation uses the shared validated frame plus `confirmed`; material defaults map existing slot keys to published global material keys allowed by that slot's family/finish constraints.

Success returns `{revision}` for the next save. Responses: 404 missing pack/variant or nonstaff caller; 409 stale revision, non-draft status or referenced variant; 422 invalid frame/material selection. The existing pack status endpoint additionally rejects present unconfirmed frames on publishing. Design overrides use the existing authorized `/api/designs/:id` versioned save endpoint and its optimistic lock.

### Decoration target edits

Zone POST accepts optional `materialSlotKey`; zone PATCH accepts a validated key or `null` to
restore automatic legacy resolution. Referenced slots must belong to the variant. Like frame
edits, target changes are permitted only on unused draft zones; published or used targets are
rejected. Draft publication and ordinary editor catalog reads retain the manifest-backed target.

### Render lighting snapshot

`POST /api/designs/:id/renders` accepts optional `lighting` alongside existing output settings:

```json
{"lighting":{"environmentKey":"studio-detail-v1","rotationDeg":0,"orientation":{"version":1,"frontSource":[0,1,0],"upSource":[1,0,0]}}}
```

Only curated studio keys, finite rotations from -360 to 360 degrees, and perpendicular unit Front/Up
axes are accepted. Invalid snapshots return HTTP 422 `invalid_lighting` before a job is queued.
Omitting `lighting` preserves saved-design lighting. The snapshot never edits the saved design.
The inspection slider is already incorporated in `orientation`; `rotationDeg` is the studio's
separate rotation around its local Up axis.
