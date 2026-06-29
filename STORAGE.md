# Document Storage (Cloudflare R2)

This service stores tenant **verification documents** (Commercial Registration,
National ID, MoH License, VAT, insurance) in a **private** Cloudflare R2 bucket.
Files are never public: the database stores only an opaque object **key**, and
reads are served through **short-lived presigned URLs**.

- Backend gateway: `src/modules/storage/` (`StorageService`, `UploadsController`)
- Verification flow: `src/modules/tenant/tenant-verification.*`
- Audit trail: `src/modules/verification-audit/`
- Admin notifications: `src/modules/admin-notifications/`

---

## 1. Cloudflare R2 setup

### 1.1 Create the bucket
1. Cloudflare dashboard → **R2** → **Create bucket**.
2. Name it per environment, e.g. `ziyarati-verification-prod`.
3. Location: **Automatic** is fine (R2 is region-agnostic).
4. **Do NOT enable public access.** This bucket must stay private.

### 1.2 Bucket permissions
- Leave **Public access = disabled** (no `r2.dev` public URL, no custom public
  domain). The app reaches objects only with signed S3 requests.
- No bucket policy is required — access is granted by the scoped API token below.

### 1.3 Create an S3 API token
1. **R2** → **Manage R2 API Tokens** → **Create API token**.
2. Permission: **Object Read & Write**.
3. Scope it to the single bucket you created (least privilege).
4. Create, then copy:
   - **Access Key ID** → `R2_ACCESS_KEY_ID`
   - **Secret Access Key** → `R2_SECRET_ACCESS_KEY`
5. Find your **Account ID** on the R2 overview page (also the subdomain in the
   S3 endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`) → `R2_ACCOUNT_ID`.

### 1.4 CORS
Uploads go **server-to-R2** (the browser uploads to our API, the API streams to
R2), and downloads use **presigned GET URLs opened in a new tab**. Neither path
is a cross-origin `fetch` to the bucket, so **no R2 CORS configuration is
required** for the current flow.

If you later switch to **direct browser → R2** uploads/downloads via `fetch`/XHR,
add a CORS policy on the bucket allowing your frontend origin and the methods you
use, e.g.:

```json
[
  {
    "AllowedOrigins": ["https://app.yourdomain.com"],
    "AllowedMethods": ["GET", "PUT"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

---

## 2. Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `R2_ACCOUNT_ID` | ✅ | — | Cloudflare account id (S3 endpoint subdomain). |
| `R2_ACCESS_KEY_ID` | ✅ | — | S3 API token access key. |
| `R2_SECRET_ACCESS_KEY` | ✅ | — | S3 API token secret. |
| `R2_BUCKET` | ✅ | — | Private bucket name. |
| `R2_REGION` | — | `auto` | SDK region string; keep `auto` for R2. |
| `R2_PUBLIC_BASE_URL` | — | — | Only for a public custom domain. Unused here. |
| `UPLOAD_MAX_BYTES` | — | `10485760` | Per-file size cap (10 MB). |
| `SIGNED_URL_EXPIRES_SECONDS` | — | `300` | Presigned URL lifetime (5 min). |

Until the four required values are present, `/uploads` returns a clear 500
("File storage is not configured…"). It is intentionally **not** a 503 (the
frontend redirects all 503s to its maintenance page).

---

## 3. Upload flow

```
Owner browser ──multipart──▶ POST /api/v1/uploads ──▶ StorageService ──put──▶ R2 (private)
                                   │                         │
                                   │                         └─ validates: MIME allow-list (PDF/PNG/JPEG/WEBP),
                                   │                            extension↔MIME, magic bytes, size, empty/corrupt,
                                   │                            sanitised filename; computes SHA-256
                                   └─ returns { storageKey, filename, mimeType, size, sha256 }   (audited: UPLOADED)

Owner browser ──▶ POST /api/v1/verification-documents/me  { docType, storageKey, sha256, … }
                                   └─ verifies object exists in R2, upserts the single active
                                      record for that docType (replace/dedup), audited.

Owner browser ──▶ POST /api/v1/verification-documents/me/submit
                                   └─ asserts ALL required docTypes present → 400 with the
                                      missing list if not; else → tenant PENDING_APPROVAL +
                                      admin notification (audited: SUBMITTED).
```

Object key layout: `<tenantId>/<docType>/<uuid>.<ext>`. The tenant prefix is the
isolation boundary — every read/delete asserts the caller owns the prefix.

---

## 4. Signed-URL (download) flow

- The bucket is private; there are **no permanent URLs**.
- To view a document, the client calls
  `GET /api/v1/verification-documents/:id/file-url`. The backend returns a
  presigned **GET** URL that **expires after `SIGNED_URL_EXPIRES_SECONDS`**.
- Owners/managers can only resolve URLs for their own clinic's documents;
  super-admins can resolve any. Each issuance is recorded (audited: `VIEWED`).
- Generic objects can also be signed via
  `GET /api/v1/uploads/signed-url?key=<key>` (same ownership rules).

---

## 5. Object lifecycle

| Event | DB record | R2 object | Audit |
|---|---|---|---|
| First upload of a docType | created (`PENDING`) | written | `UPLOADED` |
| Re-upload, different bytes | updated in place | **old object deleted**, new kept | `REPLACED` |
| Re-upload, identical bytes (same SHA-256) | reused, reset to `PENDING` | duplicate upload **discarded**, original kept | `UPLOADED` (`deduped`) |
| Delete via `DELETE /uploads` | — | deleted | `DELETED` |
| View / signed URL | — | — | `VIEWED` |
| Admin approve/reject doc | status updated | — | `APPROVED` / `REJECTED` |
| Owner submit-for-review | — | — | `SUBMITTED` |

**One active document per type.** There are never duplicate records for the same
`docType`, and replacing a document **always deletes the previous R2 object** so
the bucket never accumulates orphans.

---

## 6. Replacing documents

Owners simply upload a new file for the same document type and submit it. The
backend:
1. validates and stores the new object,
2. updates the existing record (status → `PENDING`, clears prior review note),
3. **deletes the previous R2 object** (unless the bytes are identical — then the
   new duplicate is discarded and the existing object is reused),
4. writes a `REPLACED` (or deduped `UPLOADED`) audit entry.

---

## 7. Deleting documents

`DELETE /api/v1/uploads?key=<storageKey>` removes an object the caller owns
(owner/manager, own-tenant prefix only) and writes a `DELETED` audit entry. The
replace flow deletes superseded objects automatically, so manual deletes are
rarely needed.

---

## 8. Security model

- **Private bucket** — no public access, no bucket listing exposed to clients.
- **No permanent URLs** — only presigned GETs that auto-expire.
- **Tenant isolation** — keys are prefixed with `<tenantId>/`; reads/deletes
  assert the prefix; cross-tenant access is reported as `NOT_FOUND`.
- **Upload validation (server-side, never trusts the client):** MIME allow-list,
  extension↔MIME consistency, **magic-byte signature** check (defeats spoofing /
  corruption), size cap, empty-file rejection, filename sanitisation,
  double-extension and path-traversal defenses.
- **Integrity / dedup** — SHA-256 computed server-side at upload, stored as
  object metadata and on the document record.
- **Audit trail** — every privileged action logs actor id, role, tenant,
  timestamp, **IP**, and **user agent** to `verification_audit_logs` (immutable;
  admin-readable at `GET /verification-documents/tenants/:tenantId/audit`).

---

## 9. Admin workflow

1. When a clinic submits for review, super-admins get an in-app notification
   (`GET /api/v1/admin/notifications`, unread badge at
   `/api/v1/admin/notifications/unread-count`).
2. Admin reviews documents (signed-URL `View`), optionally approves/rejects
   individual documents to request a re-upload.
3. **Approve Clinic** (`POST /tenants/:id/approve`) is **gated**: the backend
   rejects approval with **400 + the missing list** unless every required
   document type exists. **Reject Clinic** is `POST /tenants/:id/reject`.

---

## 10. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `File storage is not configured` (500) | One of the four required `R2_*` vars is unset. |
| `403`/`SignatureDoesNotMatch` on upload | Wrong `R2_ACCESS_KEY_ID`/`SECRET`, or token not scoped to this bucket. |
| `NoSuchBucket` | `R2_BUCKET` name mismatch, or token scoped to a different bucket. |
| Upload rejected: "content does not match its declared type" | Magic-byte check failed — file is corrupt or not actually a PDF/PNG/JPEG/WEBP. |
| Upload rejected: "extension does not match its content type" | Filename extension and MIME disagree (possible double-extension attack). |
| `Uploaded file was not found in storage` on submit | The `storageKey` never completed upload, or was already deleted. Re-upload. |
| Signed URL returns 403 when opened | URL expired (`SIGNED_URL_EXPIRES_SECONDS`). Request a fresh one. |
| Approve Clinic returns 400 "missing required documents" | The clinic hasn't uploaded all required types — see `context.missing`. |
| Migrations not applied | They run automatically on boot (`migrationsRun`); check app start logs / `DATABASE_URL`. |
