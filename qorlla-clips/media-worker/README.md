# Qorlla Clips media worker

Turns an avatar **draft** into a video. It is a separate process with **no database access**: it takes jobs from a Redis queue (BullMQ),
renders with FFmpeg, puts the file in object storage, and tells the Clips API ("this draft is READY" or "FAILED"). The API checks that the
file really exists before it believes the worker.

```
browser -> POST /api/avatars/drafts -> API saves the draft (PROCESSING) and queues a job (Redis, queue "avatar-render")
                                                         |
              worker takes the job: render (FFmpeg) -> upload to storage at the key the API chose -> POST /api/internal/avatar-drafts/:id/complete
                                                         |
              API: HeadObject on that key -> READY (storageKey, size) -> the page shows it -> "Save to My clips" hands the same object to a Clip
```

## What it renders today: a placeholder, not an avatar

There is no speech or face model in this project. The renderer (`src/render.mjs`) makes a 6-second **title card**: a dark background, the
words "PLACEHOLDER RENDER - NOT A REAL AVATAR VIDEO", the presenter's name, the draft's title and the first lines of its script, with silent
audio. It exists so the whole pipeline runs for real. The Avatars page says so (`rendering.kind = "placeholder"`). A real renderer replaces
`render.mjs` only; the queue, storage, API calls and page stay as they are.

## Safety

* ffmpeg gets an argument array (no shell) and all user text goes through text files, never into the filter string.
* ffmpeg is killed after 2 minutes; temporary files are removed after every job; at most `CONCURRENCY` (2) renders at once.
* The storage key comes from the API; the worker refuses a job whose key is not exactly `avatars/<org>/<draft>/render.mp4`.
* If Redis was down when a draft was created, or a job is lost, the worker asks the API for drafts still waiting (`/api/internal/avatar-drafts/pending`)
  every minute and queues them, so a draft does not wait for ever. Two attempts per job; after the last, the draft shows FAILED.

## Environment

| Variable | |
|---|---|
| `REDIS_URL` | the queue, e.g. `redis://redis:6379` |
| `API_URL` | the Clips API, e.g. `http://api:5400` |
| `SERVICE_KEY` | the same value the API has (32+ characters) |
| `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT`, `S3_REGION`, `S3_FORCE_PATH_STYLE` | the same bucket the API uses |
| `FFMPEG_PATH`, `RENDER_FONT`, `CONCURRENCY` | optional (set in the Dockerfile) |

The API needs `AVATAR_RENDERER=placeholder`, `REDIS_URL`, `SERVICE_KEY` and the S3 variables; with `AVATAR_RENDERER=none` (the default) nothing
is queued and the page says rendering is unavailable.

```bash
npm ci && npm test            # unit tests (no ffmpeg or Redis needed)
docker build -t qorlla-clips-media-worker .
```
