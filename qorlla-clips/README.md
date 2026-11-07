# Qorlla Clips

A self-contained module for the **Clips** area: a multi-tenant **Express + Prisma** API (PostgreSQL in production, SQLite for local
work and tests), object storage for video (AWS S3 or any S3-compatible store), and a **Next.js 15 (App Router) + Tailwind CSS +
shadcn/ui** front end with in-browser recording.

```
qorlla-clips/
  api/      Express + Prisma. prisma/ (schema + migrations), src/ (config, auth, app, uploads, storage), scripts/, tests/, Dockerfile
  web/      Next.js. src/app/dashboard/** (one route per sidebar item), src/components/{ui,clips,uploads}, src/hooks, src/lib, Dockerfile
  e2e/      Browser end-to-end test (Chromium, real MinIO, fake camera)
  deploy/   Production docker-compose.yml + .env.example
  docker-compose.dev.yml   PostgreSQL + MinIO for local work
../.github/workflows/clips.yml   test -> images -> (optional, gated) deploy
```

Each package has its own `package.json` and `node_modules`; nothing here touches the main Qorlla app's dependencies.

## Pages (Next.js App Router)

`/` redirects to `/dashboard/my-playlists`. Every sidebar item is a real route with its own page:

| Route | Page |
|---|---|
| `/dashboard/notifications` | share notifications (opening the page marks them read) |
| `/dashboard/recent`, `/my-clips`, `/shared-with-me`, `/starred`, `/trash` | clip library as a **list or a grid** (remembered per browser): search, cursor pagination, every clip action; grid cards show source, length, size and status |
| `/dashboard/my-playlists`, `/dashboard/organization` | playlist grids; each playlist is `/dashboard/<section>/<id>` |
| `/dashboard/creation/avatars` | clips made with avatars |
| `/dashboard/creation/projects` | an honest "not available yet" page |

`dashboard/layout.tsx` mounts the shell once (Qorlla rail, Clips navigation, toasts, the recorder, the upload queue); navigating swaps only the
page, so the sidebar never remounts or loses state. The active link comes from `usePathname()` (`aria-current="page"`; a playlist keeps its
section highlighted). `loading.tsx` shows a skeleton the instant a link is clicked; lists show the same-shaped skeleton while their first
fetch runs. Data is fetched in the browser, so `loading.tsx` covers the page's code loading, and the in-page skeleton covers the data.

## Recording and upload

```
browser                           API                                    object storage (S3 / MinIO)
  record (MediaRecorder)
  POST /api/recordings ---------> clip row (UPLOADING), key = org/user/clip.ext ---> CreateMultipartUpload
  <------- {partSize, totalParts}
  for each part (3 in parallel, retried with backoff):
  POST .../upload/parts --------> signed URL for THIS key/upload/part, exact length
  PUT bytes ------------------------------------------------------------------------>  stored
  POST .../upload/complete -----> ListParts (what storage really holds) -> check count, order, sizes
                                  -> CompleteMultipartUpload -> HeadObject: size == announced? -> READY
  GET  .../playback ------------> short-lived signed GET, only for people who may see the clip
```

What the server decides, and never takes from the browser: the object key, the part size, how many parts, each part's exact length (it is part
of the signature), and the finished file's size. The browser sends bytes only. Completion ignores any ETag or size the browser might report: the
server lists the parts in storage and verifies them. The bucket stays private; video is streamed through signed links, so permission checks
(owner, shared, organization playlist, trash) happen on every playback.

Resilience: parts retry automatically; a failed upload can be retried and **resumes** (parts already in storage are skipped); cancelling aborts
the multipart upload; uploads never finished (browser closed) are aborted after `UPLOAD_TTL_HOURS` and shown as Failed; deleting a clip forever
deletes its video. A tab with an upload in progress asks before closing.

The browser uploads straight to the store, so the store must allow it from the web app's origin (**CORS**):

* MinIO: `MINIO_API_CORS_ALLOW_ORIGIN=https://your-web-origin` (set in `docker-compose.dev.yml`).
* AWS S3: bucket CORS `[{"AllowedOrigins":["https://your-web-origin"],"AllowedMethods":["PUT","GET"],"AllowedHeaders":["*"],"MaxAgeSeconds":3000}]`.
  (No `ExposeHeaders: ETag` is needed because the server lists the parts itself.)

"Record a clip" uses the camera and microphone only while its window is open, records the unmirrored stream (the preview is mirrored), limits a
take to 10 minutes, supports WebM (Chromium, Firefox) and MP4 (Safari), and always switches the camera off. "Upload video" (paid plans) uses the
same pipeline with a file picker (WebM or MP4). "Create with avatars / from slides" still create a *Processing* clip: those pipelines are not built.

## Quick start (local)

```bash
# 1. services: PostgreSQL + MinIO (ports 55433 / 9100, localhost only)
cp .env.example .env            # set the three passwords
docker compose -f docker-compose.dev.yml up -d

# 2. API (SQLite is simplest; PostgreSQL works the same, only the URL changes)
cd api && cp .env.example .env  # fill in S3_* with the MinIO values; DATABASE_URL="file:./dev.db"
npm install && npm run db:push
S3_ENDPOINT=http://127.0.0.1:9100 S3_FORCE_PATH_STYLE=1 S3_AUTO_CREATE_BUCKET=1 AUTH_MODE=dev npm start     # :5400

# 3. web (second terminal)
cd web && npm install
NEXT_PUBLIC_DEV_USER=casey@example.com NEXT_PUBLIC_DEV_ROLE=admin npm run dev                             # :3400
```

`AUTH_MODE=dev` names the caller with the `x-dev-user` header (the web app sends it from `NEXT_PUBLIC_DEV_USER`). It is **refused when
`NODE_ENV=production`**. Recording needs a secure context: `http://localhost` and `http://127.0.0.1` count, a plain LAN address does not.

## Production

```bash
cd api
export NODE_ENV=production DATABASE_URL="postgresql://clips:...@db:5432/qorlla_clips" \
       AUTH_MODE=qorlla QORLLA_MAIN_URL=https://your-qorlla-host ADMIN_USERNAMES=casey \
       S3_BUCKET=... S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... CORS_ORIGINS=https://your-qorlla-host TRUST_PROXY=1
npm ci && npm run db:migrate && npm start
cd ../web && CLIPS_API_URL=http://127.0.0.1:5400 npm ci && npm run build && npm start
```

Put the web app on the **same origin** as the main app (for example nginx `location /clips/` -> Next.js, built with `CLIPS_BASE_PATH=/clips`).
The browser then sends the Qorlla session cookie to Next.js, which forwards `/api/*` to the Clips API, which verifies the session with the main
app (`GET /api/auth/me`) on **every request**. A logout or suspension takes effect on the next request; if the main app cannot be reached the API
answers 503 and lets nothing through. Behind a proxy set `TRUST_PROXY=1` (the API must then be reachable only through that proxy) or list the
public origin in `CORS_ORIGINS`; the cross-site check needs one of the two.

Switching databases is only the `DATABASE_URL` scheme: the scripts generate the Prisma client from a copy of `schema.prisma` with the matching
provider, so the committed schema (`postgresql`) is never edited.

### Changing the schema

Edit `schema.prisma`, then create the PostgreSQL migration against a **scratch** database and commit it with the change. CI fails if the two
disagree (`npm run check:migrations`).

```bash
SHADOW_DATABASE_URL=postgresql://user:pw@localhost:5432/scratch npm run db:new-migration -- add_something
```

## API (all under `/api`, JSON)

| Method and path | What |
|---|---|
| `GET /me` | the caller |
| `GET /navigation/summary` | sidebar counters, playlists, organization playlists, `features.upload` |
| `GET /clips?view=recent\|mine\|starred\|trash\|shared\|playlist&playlistId&source&q&cursor&limit` | cursor-paginated lists |
| `POST /clips` `{source, title?, playlistId?}` | create a *placeholder* for worker-made clips (avatars, slides) |
| `PATCH /clips/:id`, `POST /clips/:id/trash`, `/restore`, `DELETE /clips/:id` (Trash only; also deletes the video) | owner only |
| `POST /clips/:id/share` `{email}`, `DELETE /clips/:id/share/:userId` | share inside the organization; notifies the recipient |
| `POST /recordings` `{mimeType, sizeBytes, title?, durationMs?, source?}` | start an upload (`source: UPLOAD` is a paid feature) |
| `GET /clips/:id/upload`, `POST .../upload/parts`, `.../upload/complete`, `.../upload/abort` | the upload steps above (owner only) |
| `GET /clips/:id/playback` | short-lived signed link, only for people who may see the clip |
| `GET/POST /playlists`, `PATCH/DELETE /playlists/:id`, `POST /playlists/:id/clips`, `DELETE /playlists/:id/clips/:clipId` | personal and organization playlists |
| `GET /notifications`, `POST /notifications/read` | |
| `GET /analytics/overview?days=7..90` | real counts for the caller's scope (admins: the organization; members: their own clips): totals, storage, clips and **playback links issued** per day, top clips. Watch time is not measured, so it is not shown |
| `GET /analytics/report.pdf?days&title` | the same numbers as a PDF, built in memory and streamed; the title is sanitized and the file name is fixed. Nothing is e-mailed |
| `POST /clips/:id/report` `{reason}` | any member who can see a clip reports it (once; not your own) |
| `GET /admin/reports`, `POST /admin/reports/:id/resolve` `{action: dismiss\|trash}`, `GET /admin/audit` | **admins only**, own organization only. Trashing notifies the owner; every decision is written to an append-only audit log; two admins racing on one report: exactly one wins |
| `POST /internal/clips/:id/complete` | service-to-service (needs `SERVICE_KEY`): attach worker-made media; https and an allow-listed host only |

Errors are `{error, message}`; invalid input is 400 with the offending fields; anything the caller may not see is **404**, never 403, so guessed ids
confirm nothing. Storage keys and upload ids never appear in responses.

## Backups and the restore check (PostgreSQL)

```bash
cd api
DATABASE_URL=postgresql://reader:...@db:5432/clips node scripts/clips-backup.mjs backup --out /var/backups/clips --keep 14 [--upload]
RESTORE_ADMIN_URL=postgresql://admin:...@scratch-server:5432/postgres node scripts/clips-backup.mjs verify /var/backups/clips/clips-<time>.dump
```

`backup` writes a compressed `pg_dump -Fc` under a temporary name and renames it only when `pg_dump` succeeded and the file is not empty; it keeps
the newest N and, with `--upload` and `BACKUP_S3_*` set, copies the dump to a bucket (use a different account or region from the live data).
`verify` restores into a randomly named scratch database, checks that all nine tables exist, prints row counts, **always drops the scratch
database**, and exits non-zero for a missing, empty, truncated or incomplete dump. Run it from a timer after every backup, ideally against a
non-production server, and alert on a non-zero exit. Set `PG_EXEC_PREFIX="docker exec -i <container>"` to run the PostgreSQL tools inside a
container (passwords travel in the environment, never on a command line). Tested for real in `tests/backup.test.js`
(`BACKUP_TEST_PREFIX`, `BACKUP_TEST_ADMIN_URL`; opt-in because it needs a PostgreSQL it may create databases on).

## Rules the API enforces (each has a test)

- **Tenancy:** another organization's clips, playlists and users do not exist for you (404), including for its admins. A user moved to another
  organization sees and can change nothing from the old one.
- **Ownership:** only the owner edits, trashes, deletes, shares, uploads or aborts a clip. Admins manage *playlists*, not other people's clips.
- **Organization playlists:** only admins create or delete them; a member can add only their **own** clips (someone a clip was shared with cannot
  republish it organization-wide).
- **Uploads:** the browser cannot name an object, change a part's length, or complete with parts storage does not hold; the announced size is verified.
- **Writes:** need the `x-requested-with: qorlla-clips` header and a same-site `Origin` (cookie-authenticated CSRF defence).
- Strict input validation (zod, unknown fields rejected), request size limit, per-user rate limit, at most 5 open uploads per user, no stack traces.

## Tests

```bash
cd web && npm run test:unit                         # Vitest: byte/clock formatting, the upload state machine (retry, resume, cancel, concurrency)
node e2e/uploads-resilience.e2e.mjs                 # mocked network: slow handshakes, 503 outage, failing part + resume, 429, cancel, tab-close warning
BROWSERS=chromium,firefox,webkit node e2e/uploads-resilience.e2e.mjs      # the same on all three engines
cd api && npm test                                  # SQLite + an in-memory object store (fast)
S3_TEST_ENDPOINT=http://127.0.0.1:9100 S3_TEST_ACCESS_KEY=... S3_TEST_SECRET_KEY=... npm test   # + a REAL object store (throwaway bucket)
TEST_DATABASE_URL="postgresql://..." npm test       # the same suite on PostgreSQL (a disposable database)
cd web && npm run typecheck && npm run build
cd .. && node e2e/clips.e2e.mjs                     # Chromium + fake camera + real MinIO (starts one if docker is available)
```

## Changes from the original proposals (and why)

| Proposal | Here |
|---|---|
| mock user for everyone; `cors()` open to all | real identity (Qorlla session in production, dev header otherwise); CORS allow-list; cross-site check |
| organization playlists listed to **everyone** | scoped to the caller's organization |
| `videoUrl: "https://googleapis.com…"` invented for every clip | no placeholder URL anywhere; media exists only after a verified upload |
| multipart server with **no auth** that signs any `storageKey`/`uploadId` the caller sends | every call is bound to a clip the caller owns; the server builds the key and the part list, signs exact lengths, and verifies size |
| client-supplied filename in the object key | key is `org/user/clip.ext` from server-owned ids |
| ETags collected by the browser (needs `ExposeHeaders: ETag`) | the server lists parts itself; nothing the browser reports is trusted |
| strictly sequential parts, no retry, no resume, no cancel | 3 parallel parts, retry with backoff, resume, cancel, TTL sweep of abandoned uploads |
| `REC LIVE` text burned into the recorded video via canvas; chunks in React state; no Safari support | records the stream directly; chunks in a ref; WebM or MP4 by support; 10-minute limit; camera always released |
| public bucket URL as the video address | private bucket + short-lived signed playback links with permission checks |
| `docker-compose` with hard-coded passwords and a published database port, an obsolete 2023 MinIO tag | secrets from an untracked `.env`, localhost-only ports, no DB port in production |
| workflow: invalid `node-node-version`, builds Dockerfiles that did not exist, deploys on pull requests, runs `prisma migrate deploy` inside the **database** container, SSH as root, `latest` tags only | workflow runs the real tests (SQLite, PostgreSQL, MinIO, browser), builds both images, tags by commit, deploys only from `main`, only when enabled, through a protected environment, as a normal user, migrating from the API image first |
| JSX with `class`, HTML comments, `"usetsx"`, `ChevronLeftRight`, the "zoom" mark | valid TSX, real icons, Qorlla |
| `UploadProvider` that reports 100% (`ASSEMBLING`) before the server has completed, swallows the file's type, and has no retry or cancel | `uploads-provider.tsx`: progress is capped at 99 until the server confirms, parts retry, failed uploads resume, uploads cancel, and the tab warns before closing |
| a library page built from hard-coded sample clips | real data, list or grid, real status/length/size/source |

## CI/CD (`.github/workflows/clips.yml`)

Runs for changes under `qorlla-clips/` only. **api** (SQLite, PostgreSQL service, MinIO, migration-sync check), **web** (typecheck, unit tests, build),
**resilience** (the mocked-network upload scenarios on Chromium, Firefox and WebKit), **e2e** (Chromium: record -> upload -> play), then on `main` **images** (ghcr.io, tagged `sha-<commit>` and `latest`). **deploy** is off until you
set the repository variable `CLIPS_DEPLOY_ENABLED=true`, create the environment `production` with required reviewers, and add the secrets
`CLIPS_DEPLOY_HOST`, `CLIPS_DEPLOY_USER` (a normal user in the docker group), `CLIPS_DEPLOY_KEY` and the variable `CLIPS_DEPLOY_PATH`. It pulls
the new images, runs the migrations from the API image, starts the stack and checks it is healthy. **Nothing in this repository deploys anything
by itself.**

## Deliberately NOT built from the latest proposals, and why

* **Self-issued JWT access/refresh tokens (`jsonwebtoken`, `RefreshToken` table).** Identity here already comes from the Qorlla session, verified
  with the main app on every request, so logout and suspension take effect immediately. A second, parallel login system would duplicate identity
  and weaken that: the proposal also falls back to **hard-coded secrets** when the environment is empty (anyone could mint admin tokens), stores
  refresh tokens in plain text, and returns 403 for expired tokens. If a native/mobile client needs token auth later, the right design is
  short-lived tokens issued by the main app and verified here, with the secret required (no default) and refresh tokens stored only as hashes.
  Roles today are `MEMBER` and `ADMIN` (organization playlists); a `CREATOR` tier would be an entitlement of the plan, not a role.
* **HLS adaptive streaming + FFmpeg/BullMQ/Redis transcoding.** Not built, because the proposal as written is unsafe and incomplete:
  the API would take `localRawPath` **from the request body** and the worker would read, transcode and then **delete** that path, so any signed-in
  user could delete any file the worker can reach; it writes to a public `/streams/` path (no permission check on video), reads input with `-re`
  (real-time speed, so a 10-minute clip takes 10 minutes), and produces one rendition while describing "1080p and 720p". A safe version needs: the
  worker takes only a clip id, downloads the source from storage by the server-built key, transcodes renditions with a master playlist, uploads
  segments to the private bucket, and playback hands out signed access for the playlist **and every segment** (or signed cookies behind a CDN).
  That is a project of its own. Today's playback streams the original file with HTTP Range requests (seeking works) through a signed link, which
  is fine for short clips; transcoding becomes worthwhile for long videos, mixed devices or slow networks. `Video.js` is not needed for that path.
* **Analytics with hard-coded chart data, `Chart.js`, "ZOOM CLIPS" PDF with mock numbers.** Built instead from real rows (see the API table) with
  plain-SVG charts and a branded-neutral PDF streamed from memory (the proposal wrote to a shared `/tmp`, trusted a typed title, and its page
  fetched an unauthenticated `localhost:5000` URL). "Views" is honest: one playback link issued; there is no watch-time signal.
* **E-mailing a report to a typed-in address, and the weekly BullMQ + nodemailer digest.** Any signed-in user could make the server send mail
  with attachments to any address (a spam/exfiltration relay), the "distribution list" and SMTP settings were mock defaults, and a cron that
  `drain()`s a queue on boot loses jobs. If scheduled digests are wanted: recipients must be admins of the organization, SMTP credentials come
  from the environment only, the sender is a verified domain, and the job is idempotent per (organization, week). The PDF is downloaded instead.
* **Admin Moderation Control Desk on mock state.** Built on a real `ClipReport` queue: reports come from members, the queue and decisions are
  admin-only and organization-scoped, trashing notifies the owner, and every decision is in an append-only `AuditLog`.
* **OpenSearch transcript search.** There are no transcripts (nothing transcribes video), so there is nothing to index. The proposed query also took
  `organizationId` but never filtered by it, which would return other organizations' transcripts, and the client defaulted to an admin password.
  If transcripts arrive: one index per organization (or a mandatory filter), credentials from the environment, TLS, and indexing from the same
  permission model as the list views.
* **Slack / PagerDuty dispatcher.** Not wired: the paging destinations and keys belong to you and must not be invented. Failures are logged by the
  API; add a webhook URL from the environment when an on-call channel exists.
* **`exec` of backup shell scripts from a BullMQ worker, `aws s3 cp`, the "PITR" runner.** Replaced by `api/scripts/clips-backup.mjs` (below): no
  shell, no secrets on a command line, restore-tested. It is **not** point-in-time recovery (that needs WAL archiving or your provider's PITR);
  it proves that one dump restores. Scheduling it is the host's job (cron or systemd timer), not an in-app job queue.
* **Poster thumbnails.** Cards show a placeholder. Real thumbnails need a poster frame captured in the browser at record time (small JPEG, signed
  like the video) or a transcoder; neither exists yet.

## Not built (be aware)

- **Processing:** no transcoding, thumbnails or duration probing; the API trusts the declared type (it is served with that content type, so a
  mislabelled file cannot render as a page). Avatar and slide pipelines do not exist: those clips stay *Processing* until a worker calls
  `POST /api/internal/clips/:id/complete`.
- **Projects**, a full video detail page, comments, captions.
- **A real organization model in the main app.** Until it has one, a deployment is a single organization (`ORG_SLUG`) with admins named in
  `ADMIN_USERNAMES`; the schema and every query are already multi-tenant.
- Storage quotas per user/organization (only the per-file limit and the open-upload count exist), and virus scanning of uploaded files.
- The main Qorlla app's own Clips menu entry still has to link to this app (and the proxy route added).
