# File Preview, Security and Repository Audit

Date: 2026-10-29. Scope: the checked-out Workers application, its tracked assets,
reachable Git history and installed npm dependency graph. No production deployment,
project-file deletion, Git untracking or history rewriting was performed.

## Actual Stack

| Area | Implementation |
| --- | --- |
| Backend | ESM JavaScript, native Fetch/Web Streams, Pages Functions-style handlers and a custom Workers router; not Hono |
| Frontend | Precompiled Vue 3 / Element Plus / Webpack assets plus maintainable vanilla-JS enhancers |
| Hosting | Workers Static Assets, `src/worker.js`, `wrangler.toml` |
| Metadata | `img_url` KV, or optional `img_d1` D1 through a shared adapter |
| Storage | Native `img_r2` R2, S3, Telegram, Discord, Hugging Face, WebDAV; External is a redirect, not a server-side proxy |
| Coordination | One Upload Durable Object per modern upload ID; file reads do not go through DO |
| Types | JSDoc and `functions/utils/contracts.d.ts`; incremental `checkJs` gates for shared protocol/security/upload helpers, including HF multipart validation, not a full TypeScript migration |
| Tooling | Node >=22.12.0, AWS S3 SDK 3.1159.0, Wrangler 4.155.0, Mocha 12.0.3, TypeScript 5.9.3 |

The editable upstream Vue source is not in this repository. Its checked-in hashed
JS/CSS files are runtime assets, not disposable build debris. Replacing the frontend
framework or rebuilding its chunk graph requires the upstream frontend source.

## Findings and Implemented Fixes

| Priority | Finding | Implemented change |
| --- | --- | --- |
| High | Legacy `octet-stream`/ZIP metadata and attachment headers make PDF/Office files download instead of preview | Canonical MIME inference in `functions/utils/fileTypes.js`, shared by uploads and file responses; explicit preview/download intent |
| Medium | Existing `disposition=attachment/inline` overrides a newly selected preview/download action | The UI removes all conflicting intent parameters when changing actions; regression tests preserve token parameters |
| Medium | Office macro/template/slideshow extensions and MIME types disagree between frontend and backend | Canonical MIME and preview categories now cover the same Word, Excel and presentation families; macros remain inert data |
| High | R2 Range/HEAD handling was incomplete | Strict single-range/suffix/open-ended parsing, 416 with complete length, metadata-only HEAD, ETag/date preconditions and If-Range; streams remain unbuffered |
| Medium | File CORS preflight omits supported If-Match and If-Unmodified-Since validators | Both shared and file-specific allow-header lists include every supported validator; file/temp preflights require no storage binding |
| High | Real HF GET/HEAD called a nonexistent `HuggingFaceAPI.getMetadataFileSize` | Use the real shared metadata size helper; integration tests import the actual route rather than a fake API class |
| High | Same-origin Referer/from hints could bypass blocked-file policy | Only real admin sessions or explicitly admin-scoped API tokens receive privileged file access; clean URLs work with real cookies |
| High | Temporary files had long public cache lifetimes | Every token HEAD/GET/Range revalidates expiry; temp, admin and denied responses are no-store |
| High | Automatic Microsoft Viewer embeds disclose private document URLs and cannot fetch cookie-protected files | Local DOCX/Excel renderers; Microsoft is gated by explicit consent and an anonymous public-URL probe |
| High | Unknown `+xml` MIME could execute same-origin HTML through XSLT | Sandbox CSP on the parent response for all XML families, including RSS/Atom and XSL; HTML/XHTML remain attachments |
| High | Unbounded control metadata can exhaust Worker/DO memory | Actual stream byte limits for login/proxy/init/merge/HF metadata; uploaded file bodies have no application cap at the user's request; reconstructed download parts remain bounded with backpressure |
| High | Missing or inconsistent size declarations can corrupt chunk assembly | New chunk sessions require fileSize/chunkSize by default for exact per-part and final-byte integrity checks, not quotas; frontend patch sends both fields |
| High | HF commits trusted arbitrary client file IDs and concurrent origin-name sessions could overwrite one another | Six-hour server-issued argument binding, random public IDs, independent sessions, repository/privacy binding and replay receipts |
| High | HF multipart frontend delegated completion to commit, but commit never completed parts before publishing a reference | Server-issued completion descriptor, pending marker, confirmed completion receipt, then LFS commit and final metadata; failed completion never publishes a file |
| Medium | The 64 KiB control-body cap rejects legitimate large multipart manifests, and the frontend replays thousands of signed URLs | HF commit/complete have a stream-counted 2 MiB schema budget; 1..10000 exact unique parts and 128-character ETags; frontend sends only parts and logs only transfer mode |
| High | URL proxy blacklist missed normalized IPv4-mapped IPv6 and could not stop DNS rebinding | Exact trusted-host allowlist required; every redirect revalidated; credentials/unsafe schemes/ports/private literals rejected |
| Medium | HTTP channels misreported ignored ranges or opened full bodies for HEAD | Shared upstream response handling preserves actual 200/206/304/412/416; S3 uses HeadObjectCommand; validators forwarded without browser credentials |
| Medium | Private HF token could be forwarded across a Worker fetch redirect | Explicit bounded manual redirects; credentials removed across origins; intermediate bodies cancelled |
| Medium | Chunk status exposed session data and accepted client-controlled read counts | Upload authentication, strict stored session count, expiry checks, safe fields and no-store |
| High | Cleanup trusted caller-supplied chunk counts, including malformed parseInt input and nonexistent sessions | Work is bounded by a validated stored session only; missing sessions perform no guessed deletion, and deletion concurrency is at most eight |
| High | Queued cleanup could race with a live DO merge and stale KV lease, and abort failures were swallowed | Cleanup rechecks the live merge lock at execution, merge cannot enter during active cleanup, failures preserve retry state and completed sessions/receipts survive cleanup |
| Medium | Configuration cache was global across different database bindings | WeakMap-scoped raw-config cache; fresh configuration objects; current-binding invalidation after writes |
| Medium | DO/other upload errors leaked provider details | Shared production error envelope with requestId; preserve terminal MERGE_FAILED for frontend retry compatibility |
| Medium | Thirty-day browser caches outlive access-policy changes | Public policy now browser 300s/shared 3600s; ordinary private reconstructed files 300s; sensitive files no-store |
| High | Shared deletion ignored provider failures and omitted WebDAV, losing the only reference to undeleted objects | One configuration-aware `deleteStoredFile` implementation for management, batch and chat; metadata remains on remote failure; the old management export stays a compatibility alias |
| High | Delete-only callers could target internal settings/session/index records | Reserved `manage@` and actual internal chunk-record keys are rejected before database reads; ordinary filenames such as `chunk_notes.pdf` remain deletable |
| Medium | Discord chunk files have no top-level message ID and partial deletion retries failed on missing messages | Fully validate bounded manifests before mutation, delete all messages sequentially, preserve the complete manifest on failure, and treat authenticated DELETE 404 as idempotent success |
| Medium | Folder/DAV deletion acknowledged partial work; subsequent overwrite could continue | Folder responses report failed IDs, completed IDs are indexed even after later listing errors, and DAV requires a valid HTTP 200 success acknowledgement with no failures |
| Medium | WebDAV 202/207 responses were mistaken for completed deletion or MOVE | Accept only confirmed mutation statuses; asynchronous or multistatus responses retain metadata and reject overwrite acknowledgement |
| Medium | Listing outages looked like empty folders, and legacy reserved URL characters could change deletion targets | Listing fallback failures return generic no-store 500; folder traversal validates response shapes; all internal deletion paths/query values are encoded |
| Maintenance | Build assets included README-only artwork and insufficiently excluded developer output | Exclude poster, docs, type configuration, credentials, logs, coverage/build output; keep local document renderers deployable |

### Why PDF Delivery Now Works

```text
Browser iframe / authenticated HEAD
  -> Worker method/CORS boundary
  -> file policy or temporary-token policy
  -> metadata / object head
  -> R2.get({ range, onlyIf: { etagMatches } }) when needed
  -> FixedLengthStream response with MIME, inline disposition and actual range length
```

The Worker does not parse or convert a PDF and does not send document bodies into
an upload DO. A range reads only the selected R2 segment. Version checks prevent
combining bytes from an object replaced between head and get. Invalid/unsupported
multi-range requests receive 416, not a silently truncated first range.

HTTP providers may legally ignore Range and return 200; their response is no longer
mislabelled 206. Telegram/Discord read only relevant parts, with one pull at a time
and a hard 32 MiB per historical part. Each selected part is still bounded-buffered,
not a remote partial-byte fetch. Cancellation and malformed/truncated streams are
observable instead of returning silent file corruption.

### Browser Preview Boundaries

| Format | Preview |
| --- | --- |
| PDF | Native iframe viewer; original-file open/download remains available |
| DOCX/DOCM and DOTX/DOTM templates | Local parser after worker ZIP validation, rendered in an opaque sandbox iframe without application DOM or network access |
| XLS/XLSX/XLSM/XLSB/ODS and XLT/XLTX/XLTM templates | Local SheetJS worker, cached cell values; no macro/formula evaluation |
| Legacy DOC/DOT and presentation/template/slideshow families | Microsoft only after explicit consent, safe HTTPS URL and anonymous HEAD success; service format compatibility is not guaranteed and private files require download or a separately deployed trusted converter |
| Markdown/text | At most 2 MiB; inert-template allowlist sanitizer, no scripts/JavaScript URLs/remote image tracking |
| External redirect documents | Not supported by the in-app fetch-based preview; open/download follows the existing redirect. Supporting them needs a separately designed, controlled proxy, not blind credentialed redirect following |

Local Office inputs: 15 MiB; 2,000 ZIP entries; 16 MiB per expanded entry; 40 MiB
total actual expansion; 300,000 XML tags; a 15-second worker parsing deadline. Excel shows
at most 300 rows, 50 columns and 40 sheets, with bounded cell text. HTTP headers and
body reads have 30-second browser deadlines; closing the modal cancels work.
Complex Office layout/charts are not guaranteed to match desktop Office. Final DOCX
DOM rendering runs on the iframe's UI thread: its timeout is not CPU preemption and
cannot guarantee stopping an arbitrarily complex render within 15 seconds.

Four local, fixed-version libraries total 1,158,936 bytes before compression and
load on demand: JSZip 3.10.1, docx-preview 0.3.6, SheetJS 0.20.3 and marked 11.2.0.
`js/vendor/README.md` records upstream URLs, original licenses and SHA256 hashes;
tests verify those bytes. Vendored browser assets are not included in npm audit.

## Configuration and Migration

See `.dev.vars.example`; it contains no working credentials.

| Variable | Default / meaning |
| --- | --- |
| `UPLOAD_MAX_SINGLE_BYTES` | Obsolete and ignored; no application ordinary-file size cap |
| `UPLOAD_MAX_TOTAL_BYTES` | Obsolete and ignored; no application complete-file size cap |
| `UPLOAD_MAX_CHUNK_BYTES` | Obsolete and ignored; no application upload-part size cap |
| `UPLOAD_ALLOW_LEGACY_CHUNKS` | false; true is an explicit migration exception for missing declarations |
| `UPLOAD_ALLOWED_EXTENSIONS` | Obsolete and ignored; all upload extensions are accepted |
| `UPLOAD_ALLOWED_MIME_TYPES` | Obsolete and ignored; all upload MIME types are accepted |
| `CORS_ALLOWED_ORIGINS` | Empty keeps public wildcard CORS without credentials; supplied exact origins reject unauthorized cross-origin writes before side effects |
| `CORS_ALLOW_CREDENTIALS` | Only literal true plus an exact configured allowed origin can enable credentials; never wildcard credentials |
| `FETCH_ALLOWED_HOSTS` | Required exact trusted hostnames for /api/fetchRes; empty disables this proxy |
| `EXTERNAL_ALLOWED_HOSTS` | Optional exact restriction for External redirects; private literals and embedded credentials always rejected |

Ordinary and chunk file-upload bodies bypass application envelope limits at both
Worker and DO boundaries. Init/merge/HF getUploadUrl control metadata remains capped
at 64 KiB; HF commit/complete metadata has a 2 MiB budget sufficient for 10000
128-character ETags; proxy/login JSON is capped at 16 KiB. All count actual bytes
rather than only Content-Length. These are schema and parser budgets, not file quotas.
R2/S3 non-final multipart parts must still meet the provider's 5 MiB minimum.
No extension/MIME allowlist or old configured file-size cap rejects an upload.
Cloudflare plan-specific request-body/CPU/subrequest/memory limits and each
provider's constraints still apply; use supported chunk/direct transfer for large
files. Browser text/Office parser limits apply to preview, not file acceptance.
The remote-URL import proxy is a separate feature: its response remains bounded
to 25 MiB and its whole-body deadline is 10 seconds. File-upload quota removal
does not mean an unrestricted SSRF-capable remote fetch service.

The supplied frontend now declares actual file/chunk byte sizes. Hard-refresh old
cached upload bundles after deployment. Existing legacy sessions should be restarted;
setting the legacy switch to true permits missing historical size declarations,
but forfeits exact layout checks. Neither mode enforces an application file quota.

HF direct public IDs now include a UUID even in origin-name mode; original names
remain in metadata and Content-Disposition. In-flight pre-upgrade direct uploads
must request a new URL/session. Configuration identity changes during an issued
upload are rejected with 409. Immutable HfObjectRepo/HfObjectPrivate identify the
stored object separately from credentials/config-derived fields.

HF direct sessions validate the issued LFS size/hash descriptor for consistency,
not an application file-size limit: the browser uploads directly to the provider.
Independent post-upload object integrity checks remain important. Application
upload-size/type quotas are disabled as explicitly requested by the user.

HF multipart completion now uses only an issued descriptor: the completion URL,
bounded provider metadata, chunk size and part count. Signed part URLs are not
persisted or replayed by the commit payload. Completion capabilities can still be
sensitive: keep the manage@direct-upload namespace private and out of file metadata,
logs and backups shared with untrusted users. The browser logs the transfer mode,
not the complete upload action. Pre-upgrade multipart sessions without a descriptor
must be reinitialized; basic/already-existing issued sessions remain compatible.

A pending marker precedes the remote completion POST. Only confirmed 200/201/204,
with a fully consumed response bounded to 64 KiB and a 30-second deadline, produce
a completed receipt. Ambiguous transport, redirect, 5xx, 408/429 or asynchronous
202/206 outcomes retain the marker. A retry probes the exact LFS OID/size and requires
no remaining upload action before continuing, rather than blindly completing again.
Completed receipts survive subsequent commit or metadata failures. They support
recovery, not global exactly-once: the flight map deduplicates only within one
database binding/isolate and KV does not provide distributed CAS.

Deletion uses current configured credentials, never persisted historical secrets.
Where legacy metadata contains an S3 bucket/endpoint, Discord channel or WebDAV
base URL, destructive operations reject changed object identities rather than
following a repointed channel. Scheme, port, path and repeated path slashes matter;
credential rotation does not change the object identity. Previously sanitized
records with no stored identity cannot reconstruct their historical storage root:
do not repoint those channel names without an explicit storage/metadata migration.
HF deletion retains its immutable stored repository identity.

Remote deletion and KV/D1 metadata/index updates are not one transaction. On a
provider failure, retry using the retained record; a Discord retry may see 404 for
parts already removed. A metadata-write failure after remote success retains the
record where the database allows it. Cache invalidation is best-effort after a
committed metadata delete and does not suppress its successful index update.
Telegram/External/legacy records still support metadata-only deletion: this does
not claim removal from Telegram or a third-party external host. The 10,000-part
validator ceiling is a protocol guard, not proof that 10,000 remote subrequests
fit a Cloudflare request; large cleanup needs resumable background coordination.

Configure BASIC_USER/BASIC_PASS and appropriate user authentication before exposing
the service: existing setup mode intentionally opens management APIs when admin
credentials are unset. Files are public by default unless file-access rules restrict
them; an upload authCode or hotlink Referer allowlist is not a universal private-file
ACL. CORS is not authorization and does not override SameSite cookie policy.

Purge old edge file caches on deployment. Old thirty-day browser entries cannot be
revoked reliably; use changed URLs/cachebusters for sensitive changes. Never let a
Cache Everything rule bypass /file or /temp policy. s-maxage declares a cache policy;
it does not automatically create a Cache API entry for an R2 binding response.

## File -> Processing Recommendation

No project files in this table have been deleted. Conditional deletion requires
confirmation of Workers-only support and the intended workflow/cache scope.

| Path | Recommendation | Evidence / condition |
| --- | --- | --- |
| `functions/dav/_middleware.js` | Delete after confirmation | Not imported by Workers; old Pages wrapper |
| `functions/file/_middleware.js` | Delete after confirmation | Same; current Worker method/CORS chain lives in src/routes.js |
| `functions/random/_middleware.js` | Delete after confirmation | Old Pages wrapper, unreachable from Worker module graph |
| `functions/temp/_middleware.js` | Delete after confirmation | Old Pages wrapper; token policy remains in handler |
| `functions/upload/_middleware.js` | Delete after confirmation | Legacy Pages preflight wrapper; Worker/DO now handle this boundary |
| `functions/music/_middleware.js` | Delete after confirmation | No-op Pages wrapper |
| `functions/api/_middleware.js` | Keep | Generated auth routes still import it |
| `functions/utils/deleteFile.js` and `functions/api/manage/delete/[[path]].js` | Merged; keep both entry points | Shared provider deletion is centralized; the management route retains a compatibility export; batch and chat use the same helper and failures preserve records |
| `functions/api/huggingface/getUploadUrl.js` / `commitUpload.js` | Keep | Active one-line compatibility re-exports, not obsolete APIs |
| `functions/file/[[path]].js` | Keep; logic merged now | Shared reconstructed-part serving and HTTP responses replace duplicate Telegram/Discord/provider flows |
| `functions/utils/fileTypes.js` | Keep | Canonical upload/file MIME logic extracted from fileTools |
| `functions/file/fileTools.js` / `decodeFilePathParam` | Delete unused function after confirmation; keep file | No caller in functions/src/test/deploy/scripts |
| `functions/upload/chunkProtocol.js` / `normalizeUploadSession`, `canReuseCompletedChunk`, `classifyChunkStatuses` | Delete or integrate unused functions after confirmation; keep file | Searches find definitions only; initialization/status logic can reuse helpers instead of maintaining unused parallel implementations |
| `functions/upload/chunkUpload.js` / `cleanupUploadSession` | Delete unused function after confirmation; keep file | Actual cleanup uses forceCleanupUpload; no caller of this legacy helper |
| `functions/utils/auth/tokenValidator.js` / `getTokenInfo` | Delete unused function after confirmation; keep file | Definition only, with legacy KV token-settings access |
| `deploy/worker/generate-routes.js` / `route-coverage.js` | Keep; optional small merge | Separate generation/audit jobs; duplicate export-detection utility can later be shared |
| `css/100.07b87787.css` / `css/214.07b87787.css` | Keep | Identical bytes, but two distinct Webpack runtime chunk URLs are live |
| `js/*.hash.js`, `css/*.hash.css`, font/background/logo assets | Keep | Direct and lazy runtime references; all numeric JS/CSS chunks are reachable |
| `js/*-enhancer.js`, document frame/worker/guards and `js/vendor/` | Keep | Active application code and lazy local preview assets, with license/hash tests |
| `functions/upload/huggingface/multipartProtocol.js` / `directUploadSession.js` | Keep | Shared bounded completion validation, protected descriptors and recovery receipts; both commit and standalone completion use them |
| README-only poster under `img/` | Keep in Git, exclude deployment (done) | Both READMEs reference it; 1,124,339 bytes do not belong in runtime assets |
| `scripts/patch-admin-session.mjs`, `patch-music-admin-password.mjs`, `patch-tg-upload-performance.mjs`, `patch-hf-multipart-completion.mjs` | Keep | Idempotent patches run at every asset build and have regression tests |
| `test/`, database initialization/migration SQL | Keep | Real regression and optional D1 deployment inputs, not test debris |
| `.github/workflows/sync-release.yml` | Conditional deletion | Fork does not match hardcoded upstream repository; confirm release-sync intent |
| `.github/workflows/sync.yml` | Keep or disable after confirmation | Scheduled write access/upstream main sync may conflict with fork customizations; prefer reviewed PRs |
| `node_modules/`, `.wrangler*/`, `data/`, `.workbuddy-ai/`, `.playwright-mcp/` | Optional local cleanup after confirmation | Untracked generated/cache/state trees; some contain useful local data, not Git mistakes |
| `package.json` direct dependencies | Keep | AWS SDK has real backend imports; Mocha/Wrangler/TypeScript run tests/build/dev/typechecking |
| `package.json` / `overrides.fast-xml-parser` | Delete obsolete override after confirmation | npm ls and the lockfile contain no fast-xml-parser; the upgraded SDK uses @aws-sdk/xml-builder |

Do not delete hashed frontend chunks merely because rg finds no static import.
Webpack's runtime hash tables and dynamic import paths are their references.

## Git and Dependency Audit

Original tree: 224 tracked files. Current tracked artifact/credential filename-pattern
matches: zero, so git rm --cached was not needed. Ignore rules now cover node_modules,
Wrangler output, dev vars/envs, dist/build/coverage, logs, IDE metadata, Playwright,
credential directories/key formats, credentials.json, .wrangler-config and type-build caches. The maintained audit report
and credential-free dev-vars example have explicit exceptions. Asset ignores also
exclude secrets and source/config/test/docs recursively.

Reachable pre-change history: 990 commits, 3,965 unique blobs, largest blob 2,451,399
bytes (about 2.34 MiB), no blobs >=10 MiB. About 52.05 MiB packed Git storage;
179 historical package/dist paths and repeated compiled releases contribute volume.
The resumed streaming heuristic secret check covered 3,917 text blobs (48 binary blobs
skipped) and found no high-confidence
AWS/GitHub/HF/Telegram/PEM/Slack patterns. This is not proof of a secret-free history:
arbitrary Cloudflare tokens, passwords, binary data and unknown formats need a dedicated
gitleaks/trufflehog scan. If anything is found, revoke/rotate first, then coordinate
filter-repo/history rewriting with all collaborators. Historical generated artifacts
include .wrangler-pages-func-build/index.js, wrangler.log and package/dist paths;
deleting today's files does not erase those versions. No history changes were made.

Registry npm audit before upgrade: 34 vulnerabilities (13 high, 20 moderate, one low).
After supported SDK/Wrangler upgrades and Mocha 12 / TypeScript installation:
zero reported vulnerabilities, reconfirmed with npm audit --json on this resume. The lockfile records the tested versions; npm ci is
the reproducible install path. Mocha 12 requires Node >=22.12 for the selected Node 22
line. No unused direct dependency was removed without confirmation.

## Validation

- Re-audit baseline: 442 passing tests. Current: **506 passing**, including real route imports,
  in-memory KV/R2 bindings, real FormData/Web Streams and real XLSX/ZIP parsing.
- `npm test -- --reporter dot`: passes route generation/60-of-60 coverage, incremental
  typecheck and the full Mocha suite.
- `npm run build:worker`: succeeds with Wrangler 4.155.0; 73 deployable assets;
  Worker bundle 1,498.37 KiB / gzip 281.55 KiB. This was dry-run only.
- All 73 changed/new JavaScript and script files pass `node --check`; Git diff
  whitespace checks pass. Ignored tracked-file query returns no entries.
- Chromium: visible native PDF page, authenticated DOCX/Excel and sheet switching,
  opaque sandbox DOM isolation, malicious XML/XSLT/DOCX/Markdown cases and 375x812
  mobile modal cleanup tested. No external private-document requests or script dialogs.
- Resume smoke: actual file route with in-memory R2/KV and a real test admin session;
  PDF HEAD 200/Range 206 and anonymous 403, local DOCX text in an opaque iframe,
  both real XLSX sheets, mobile modal cleanup and inert Markdown all pass.
  This is a local fixture, not proof of production account/provider availability.
- Re-audit headless Chromium: stale attachment intent becomes inline PDF, a real
  16-byte PDF range returns 206, DOCX opaque-frame DOM and both XLSX sheets render,
  malicious Markdown stays inert, and 390px mobile has no horizontal overflow.
  No remote document requests or Runtime/CSP errors. Helpers were shut down afterward.
- HF provider-mocked tests cover 1500/10000 part manifests, completion-before-commit,
  descriptor/target tampering, bounded streamed bodies, failure-safe receipts,
  uncertain-response recovery and a stalled completion response deadline. These
  verify protocol behavior without uploading real multi-gigabyte files or mutating a provider.
- Not tested live: production Cloudflare bindings/account limits, Firefox/Safari,
  Microsoft's viewer, actual customer files, or real provider mutations.

## Remaining Architecture / Upgrade Work

1. Keep DO for upload identity and coordination, not file/PDF delivery. KV lease/revision
   checks are not atomic CAS. Disabling DO or falling back from old identifier protocols
   lacks cross-request transactional merge ownership. Move coordination/manifests and
   multipart initialization to DO durable storage/transactions, with alarms or a queue
   for recoverable background retries and orphan cleanup. Current per-upload runSerial
   also serializes upstream chunk I/O: split short atomic state mutations from parallel
   provider transfers only after introducing durable transactional ownership. Do not
   assume I/O resets CPU. Live cleanup/merge locks prevent same-instance races, not
   cross-isolate or post-restart coordination.
2. R2 multipart already exists; do not add a parallel merge implementation. Direct
   presigned R2 upload is a separate follow-up requiring bucket-scoped S3 credentials,
   exact bucket CORS and frontend protocol work: authenticated init -> random owner-bound
   key/short-lived PUT or part URLs -> server HEAD/size/identity validation at completion
   -> sanitized metadata/index commit. Never accept arbitrary completion keys or treat
   a declared browser size as verified object size.
3. Native binding reads are streamed. Upload parts/S3 can buffer file input and
   reconstruction has bounded buffers. Without application upload-size caps, memory
   pressure from parser/Blob/SDK copies still hits Cloudflare runtime limits. Use
   provider-supported chunk sizes and load-test worst-case documents; configure
   incomplete-multipart lifecycle rules and prefer R2 direct transfer for very large files.
4. Add opt-in public full-200 edge caching only after current permission checks and with
   invalidation; exclude temp/admin/auth-bearing responses and unsupported partial cache
   writes. Check plan object-size limits. A separate immutable upload domain helps avoid
   stored-content origin risks but needs proper authentication/CORS before moving private files.
5. Cloudflare Images/Images binding or bounded background WASM can generate image variants;
   use pixel/decompression limits and preserve originals/animation/EXIF decisions. No image
   conversion service or account binding was silently added in this change.
6. Private legacy Word/presentations need a trusted OnlyOffice/conversion service, authenticated
   short-lived access and worker/queue capacity. No service/account exists here to configure
   safely; Microsoft consent mode is not a private-file conversion substitute.
7. Deletion helpers are now consolidated and covered by 129 new provider/workflow
   regressions. Move large remote cleanup into resumable coordination if needed;
   do not advertise atomic storage/metadata/index deletion or guaranteed cache purge.
   Preserve object-root identity during channel migrations; old sanitized metadata
   cannot establish an omitted historical bucket or server. No route/file was deleted.
8. Add deployment-specific WAF/rate limits for login/proxy/upload initialization, global
   authenticated storage quotas and structured log redaction. Allowlisted DNS hosts must
   be trusted/admin-controlled; literal-IP validation alone cannot prove DNS ownership.
   Incremental type gates should expand as editable frontend/backend source is consolidated.
