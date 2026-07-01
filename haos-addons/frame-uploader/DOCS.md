# frame-os Uploader

A Home Assistant OS add-on wrapping `src/app.py` + `src/processor.py`. This is
the **entire ingest+process pipeline** in one add-on: it serves the upload
page, saves raw uploads into `/share/frame/incoming`, and — immediately,
inline, on the same request — processes each one into
`/config/www/frame/photos/` + `manifest.json`. It is the only writer of both.
See [`../../CLAUDE.md`](../../CLAUDE.md) for the full architecture contract.
HAOS is the only place this project runs, so `src/app.py` and
`src/processor.py` are the **single source of truth** for this add-on — they
aren't synced in from anywhere else.

## Inline processing (read this before changing app.py)

Previously this pipeline was two add-ons: `frame-uploader` (ingest only) and
`frame-pipeline` (a separate service polling `incoming/` every
`poll_interval` seconds). They've been merged: `frame-uploader` is now the
**only** writer of `incoming/`, so there's nothing left for a separate poller
to race against or wait on — the add-on that just wrote the file can process
it itself, synchronously, in the same request.

`POST /upload` now:

1. Validates + saves the raw file and `<name>.meta.json` sidecar to
   `INCOMING_DIR`, exactly as before.
2. Calls `processor.process_one()` **directly as a Python function** (not a
   subprocess) on that one file: downscale, strip EXIF, write to
   `OUTPUT_DIR/photos/`, update `manifest.json` atomically (temp file +
   rename, content-hashed id, same idempotency guarantees as before).
3. Returns **only after processing completes** — `200 {"id", "channel",
   "status": "ok", "w", "h"}`, where `id` is the published photo's content-hash
   id (not the ephemeral per-upload receipt id from before the merge).

**Design choice: synchronous response, not a "processing" status + poll
endpoint.** A single already-decoded small photo (already capped by
`max_upload_mb`) resizes and re-encodes in well under a second even on
modest hardware — there's no meaningful latency to hide behind a poll loop,
and a poll endpoint would add a second code path and a second failure mode
(client gives up polling, upload succeeded anyway, etc.) for no real benefit.
If uploads ever need to support much larger batches or slower processing,
revisit this — but don't add polling speculatively.

If processing fails (corrupt/undecodable image slipping past the upload
route's own decode check, or a disk error), `/upload` returns `500` — the raw
file and sidecar are left in `incoming/` (quarantined by the processor if it
was actually a decode failure), and can be reprocessed manually (see below).

There is no more loop/poll mode: `processor.py`'s old `--loop` /
`run_loop()` / `POLL_INTERVAL` are gone, since there's only one writer to
`incoming/` now and it always processes what it writes immediately.

## Manual reprocessing (one-shot CLI)

`processor.py` keeps a one-shot, directory-scanning entrypoint for when
something's stuck in `incoming/` (e.g. a crash mid-upload left an orphaned
file, or you're bulk-importing from elsewhere directly into `incoming/`):

```bash
python3 /app/processor.py            # process whatever is waiting, then exit
python3 /app/processor.py --incoming /share/frame/incoming \
                           --photos /config/www/frame/photos \
                           --manifest /config/www/frame/manifest.json
```

It is **not** a running service — just an occasional manual command (e.g. via
the add-on's **Terminal** / SSH access, or `docker exec`). It uses the same
settle-wait / grace-period logic the old poller used, since directory-scanned
files might still be mid-write.

## API

- `GET /` — the upload page (self-contained HTML/CSS/JS, no external assets).
  Its JS posts to `POST /upload` on a *relative* path so it keeps working
  under HA Ingress's per-add-on path prefix. Unchanged by this merge.
- `POST /upload` — multipart form: `file` (the image), `uploader` (free-text
  name, typed into the page's "Your name" field and remembered in the
  browser's `localStorage`), `caption` (optional). Validates the bytes really
  are a decodable image, enforces `max_upload_mb`, rate-limits to
  `rate_limit_per_min` per client. Saves `incoming/<upload-id>.<ext>` +
  `incoming/<upload-id>.<ext>.meta.json` (`{uploader, caption, channel: "ha",
  ts}`), then processes that file inline. Returns
  `200 {"id": "<content-hash>", "channel": "ha", "status": "ok", "w": ..,
  "h": ..}` once the photo is live in `manifest.json`, or a 4xx/5xx on
  failure. See "Security model" below for when `X-Upload-Token` is required.
- `GET /health` — liveness probe.

No HA auth/user API is involved in attribution — the name typed into the page
rides along the `page → incoming/ → inline processing → manifest.json` path
as an ordinary form field, and the frame shows it as the sender chip.

The add-on serves its own upload UI at `GET /` — no Lovelace card or dashboard
config needed. Reached via HA Ingress, it can live as a **sidebar panel**
(see "Show in sidebar" below) or simply be opened from Settings → Add-ons →
frame-os Uploader → **Open Web UI**.

## The photo/manifest contract

Two files are dropped into `/share/frame/incoming` per photo (by this add-on,
now the sole writer):

1. an image — `sunset.jpg`
2. a sidecar — **`<image>.meta.json`** — `sunset.jpg.meta.json`

Inline processing turns each pair into a normalized photo + manifest entry
immediately after it's written.

```
incoming/                         inline processing         photos/ + manifest.json
  sunset.jpg            ─┐      honor EXIF rotation        photos/<id>.jpg
  sunset.jpg.meta.json  ─┴──▶   downscale <=1280 long ──▶  manifest.json entry
                                 re-encode JPEG q85         (display reads these)
                                 strip EXIF
```

### meta.json schema

`<image>.meta.json` is a JSON object:

| field      | type   | meaning                                            |
|------------|--------|----------------------------------------------------|
| `uploader` | string | who added the photo (display name / handle)        |
| `caption`  | string | caption to show with the photo (may be empty)      |
| `channel`  | string | which ingest channel produced it (currently just `"ha"`; the field stays channel-agnostic so more can be added later) |
| `ts`       | string | ISO-8601 UTC timestamp the photo was added         |

Example:

```json
{
  "uploader": "alice",
  "caption": "Sunrise over the hills",
  "channel": "ha",
  "ts": "2026-06-01T09:00:00Z"
}
```

All fields are tolerated-missing: an absent or empty value falls back to a
default (`uploader`/`channel` → `"unknown"`, `caption` → `""`, `ts` → the
image's mtime). This only matters for the manual-reprocessing CLI path (the
upload route always writes a complete sidecar before the image is revealed).

### manifest.json schema

`manifest.json` is a JSON array, sorted oldest-first by `ts`:

| field      | type   | meaning                                              |
|------------|--------|-------------------------------------------------------|
| `id`       | string | content hash of the **source** image (stable id)     |
| `file`     | string | output filename in `photos/` (always `<id>.jpg`)     |
| `uploader` | string | from the sidecar                                     |
| `caption`  | string | from the sidecar                                     |
| `channel`  | string | from the sidecar                                     |
| `ts`       | string | from the sidecar                                     |
| `w`        | int    | processed width in px                                |
| `h`        | int    | processed height in px                               |

## Guarantees

- **Idempotent.** Re-running never duplicates: the `id` is a content hash, so a
  photo already published (output file present) is skipped. Dropping the same
  image twice (even under a different name) collapses to **one** entry.
- **Self-healing manifest.** Entries whose backing file no longer exists in
  `photos/` are pruned by the manual-reprocessing CLI (the inline upload path
  doesn't prune on every request, to keep uploads fast — run the CLI if you
  need a prune).
- **Robust to corrupt input.** The upload route already fully decodes the
  image before saving; if something still fails during processing it's moved
  to `incoming/_rejected/` (with its sidecar) instead of crashing.
- **Normalization:** EXIF orientation is baked in, the long edge is capped at
  `max_long_edge` (default 1280px, never upscaled), output is JPEG
  `jpeg_quality` (default 85) with EXIF stripped. Transparency is flattened
  onto white.
- **Atomic writes.** Both the output image and `manifest.json` are written via
  temp-file + atomic rename.

## Security model

1. **HA Ingress** (`ingress: true`, `ingress_port: 8099`, no `ports:` key in
   `config.yaml`) — no port is opened on the host at all. The only way to
   reach the container is through the Supervisor's ingress proxy, which only
   proxies requests for an already-logged-in HA user. Per Home Assistant's own
   ingress requirements, the add-on **must** deny anything not from the
   Supervisor's fixed internal address `172.30.32.2` — `run.sh` sets
   `RESTRICT_TO_SUPERVISOR=true`, which `app.py`'s middleware enforces (see
   `src/app.py`, function `_restrict_to_supervisor`).
2. **`upload_token` is enforced only for non-ingress traffic.** Once the
   middleware above has verified a request came from the Supervisor's ingress
   proxy, it's already known to be authenticated (by the HA session) and
   same-origin (the ingress iframe serves the upload page and `/upload` under
   the same per-add-on path prefix) — a second bearer-token check on top of
   that would be pure ceremony, and it would mean the upload page's plain
   client-side JS would need to know a secret it has no way to keep
   confidential in a page's source. So: the middleware sets
   `request.state.ingress_verified = True` once a request has passed the
   Supervisor-IP check, and the `/upload` route only rejects a
   missing/wrong `X-Upload-Token` when `ingress_verified` is `False` — i.e.
   `upload_token` is real, load-bearing protection **only** in the mapped-port
   fallback below (where `RESTRICT_TO_SUPERVISOR` is unset and nothing else
   authenticates the caller). It's still **required** at setup time
   (`config.yaml`'s `match(^.{16,}$)` schema, checked again in `run.sh`) so
   switching to the fallback later doesn't silently ship with a blank secret.

Also always on regardless of transport: full image decode validation (not
just a header sniff — rejects truncated uploads), a size cap (`max_upload_mb`),
and a per-client rate limit (`rate_limit_per_min`).

**Honesty note:** the ingress transport is implemented per Home Assistant's
documented add-on/ingress conventions (config.yaml flags, the `172.30.32.2`
restriction), but it was **not exercised against a live Home Assistant
Supervisor** while building this — there was no HAOS instance available in
that environment. Test it on your own install before relying on it. If
anything about the ingress path doesn't work for you, the mapped-port fallback
below is a complete, independently-working alternative — same app, same
security checks, just a different door.

## Options

| Option | Type | Default | Description |
|--------|------|---------|--------------|
| `upload_token` | password (≥16 chars, **required**) | *(blank — you must set it)* | Shared secret enforced only for the mapped-port fallback (see below) — ignored for ingress-origin requests, which don't need it (see "Security model" above). Still required at setup so the fallback is never accidentally left unprotected. Generate one with `openssl rand -hex 32`. |
| `max_upload_mb` | int (1–100) | `25` | Hard size cap per upload. |
| `rate_limit_per_min` | int (1–120) | `12` | Max uploads accepted per client per rolling 60s window; extras get `429`. |
| `allowed_origins` | str | `*` | CORS allowlist. Only matters for the mapped-port fallback (ingress requests are same-origin, so CORS doesn't apply). |
| `max_long_edge` | int (320–4000) | `1280` | Downscale so the long edge is at most this many px (never upscales). |
| `jpeg_quality` | int (50–100) | `85` | Re-encode quality for the output JPEG. |

Changing an option and clicking **Save** restarts the add-on with the new
value — no rebuild needed (options aren't baked into the image).

## Shared paths (this add-on's `map:`)

| Container path | HA volume | Mode | Purpose |
|---|---|---|---|
| `/share/frame/incoming` | `share` | rw | Writes uploads; deletes/quarantines them after inline processing. |
| `/config/www/frame` | `homeassistant_config`, `path: /config` | rw | Writes `photos/` + `manifest.json`. |

Both directories are created automatically on startup if missing. Because
`/config/www/` is Home Assistant's own `www` folder, the output is
automatically served at **`/local/frame/`** — point the `frame/` display PWA's
`VITE_MANIFEST_URL` / `VITE_PHOTOS_BASE` at your HA URL + that path.

## Install / reload as a local add-on

1. Copy this whole `frame-uploader/` folder into your HAOS local add-ons
   location (see [`../README.md`](../README.md) for the `/addons/` path note).
2. Settings → Add-ons → Add-on Store → ⋮ → **Check for updates** (or
   **Reload**). "frame-os Uploader" appears under **Local add-ons**.
3. Install it. **Before starting**, open its **Configuration** tab and set
   `upload_token` — the add-on will refuse to boot without one (both
   Supervisor's schema validation and a belt-and-suspenders check in `run.sh`
   enforce this), even though it isn't checked for ingress traffic — see
   "Security model" above for why it's still mandatory.
4. Start it. Check the **Log** tab for `frame-uploader starting on :8099
   (ingress only)`.

## Open the upload page / show it in the sidebar

The add-on's **Info** tab has an **Open Web UI** button that opens the upload
page (`GET /`) directly via ingress — that alone is enough to use it.

To pin it as a sidebar panel instead:

1. Go to the add-on's **Info** tab.
2. Toggle **"Show in sidebar"**.
3. "Frame Photos" (from `panel_title` in `config.yaml`, with the
   `panel_icon: mdi:image-plus` icon) appears in the HA sidebar for that user.
   The toggle is per-user, so each family member does this once on their own
   HA account.

## Alternative: mapped port (skip ingress)

If ingress gives you trouble, or you'd rather manage exposure yourself behind
your own reverse proxy:

1. Edit `config.yaml`: delete the `ingress:` / `ingress_port:` /
   `panel_icon:` / `panel_title:` lines, and add:
   ```yaml
   ports:
     8099/tcp: 8099
   ports_description:
     8099/tcp: "frame-os uploader HTTP API"
   ```
2. Bump `version` and reinstall (see "Iterating" below).
3. Proxy `https://ha.example.com/frame-upload/` → the add-on's host:8099, e.g.:
   ```nginx
   # within your existing HTTPS server { } for ha.example.com
   location /frame-upload/ {
       proxy_pass http://127.0.0.1:8099/;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
       client_max_body_size 30m;            # >= max_upload_mb
   }
   ```
   then open `https://ha.example.com/frame-upload/` to get the same upload
   page.
   `RESTRICT_TO_SUPERVISOR` no longer applies in this mode (only ingress
   traffic originates from `172.30.32.2`); the shared-secret `upload_token` is
   now the only thing protecting the endpoint, so make sure your reverse
   proxy passes `X-Upload-Token` through unmodified if you inject it there, or
   have callers set it directly. The bundled upload page itself never sends
   the token (it's built for the ingress path) — a mapped-port deployment
   needs its own client (e.g. `curl`, or a small script) that adds the header.

## Iterating on the code

`src/app.py` and `src/processor.py` are edited directly here — there's no
separate canonical copy to sync in from anywhere else. `requirements.txt` in
this folder is maintained by hand (Alpine-appropriate; notably plain
`uvicorn`, not the `[standard]` extra — see the comment at the top of that
file for why).

After an edit, bump `version` in `config.yaml` and **Check for updates** →
**Update** in the Add-on Store (Supervisor only rebuilds on a version bump).

## Multi-arch build note

Base images are pinned per architecture in [`build.yaml`](./build.yaml)
(`ghcr.io/home-assistant/{arch}-base-python:3.12-alpine3.24`, confirmed to
exist for both `amd64` and `aarch64`). As of Supervisor 2026.04.0, `build.yaml`
is a **deprecated-but-still-supported** mechanism (Supervisor logs a warning
but still builds from it); the platform's newer preferred approach is a bare
`FROM` in the Dockerfile pointing at a unified multi-platform manifest image
(e.g. `ghcr.io/home-assistant/base-python:3.12-alpine3.23`, which also exists
today). See [`../README.md`](../README.md) for the full note on why `build.yaml`
was still used here and how to migrate later.
