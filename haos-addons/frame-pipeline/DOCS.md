# frame-os Pipeline Processor

A Home Assistant OS add-on wrapping `src/processor.py` — the **only writer**
of `photos/` + `manifest.json`. See [`../../CLAUDE.md`](../../CLAUDE.md) for
why that boundary matters. HAOS is the only place this project runs, so
`src/processor.py` is the **single source of truth** for the processor — it
isn't synced in from anywhere else.

For the mock-data generator used to develop the `frame/` PWA without any real
ingest, see [`../../pipeline/README.md`](../../pipeline/README.md) — that's
the one thing that still lives outside `haos-addons/`, since it's a local dev
tool with nothing to do with the HAOS runtime.

## The photo/manifest contract

Any ingest channel (today, just the `frame-uploader` add-on) drops **two
files** into `/share/frame/incoming` per photo:

1. an image — `sunset.jpg`
2. a sidecar — **`<image>.meta.json`** — `sunset.jpg.meta.json`

The processor turns settled pairs into normalized photos + manifest entries.
Channels know nothing about processing or the manifest; the processor knows
nothing about which channel produced a file. That's what makes channels
swappable.

```
incoming/                         processor                photos/ + manifest.json
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
image's mtime). A sidecar that is missing entirely is **waited on** for up to
`NO_META_GRACE` seconds (default 120) in case the channel is still writing it,
then the image is processed with defaults.

### manifest.json schema

`manifest.json` is a JSON array, sorted oldest-first by `ts`:

| field      | type   | meaning                                              |
|------------|--------|------------------------------------------------------|
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
  `photos/` are pruned on the next run.
- **Robust to partial / concurrent writers.** Only files untouched for
  `SETTLE_SECONDS` (default 2s) are considered, so half-written uploads are left
  alone. The manifest and every output image are written via **temp-file +
  atomic rename**.
- **Robust to corrupt input.** Undecodable images are moved to
  `incoming/_rejected/` (with their sidecar) instead of crashing or being
  retried forever.
- **Normalization:** EXIF orientation is baked in, the long edge is capped at
  **1280px** (never upscaled), output is JPEG **quality 85** with **EXIF
  stripped**. Transparency is flattened onto white.

### Tunables

Constants at the top of `src/processor.py`: `MAX_LONG_EDGE` (1280,
env-overridable via `max_long_edge`), `JPEG_QUALITY` (85, env-overridable via
`jpeg_quality`), `SETTLE_SECONDS` (2), `NO_META_GRACE` (120), `POLL_INTERVAL`
(30, env-overridable via `poll_interval`), `ID_LEN` (16).

## What it does

Runs the processor in `--loop` mode (polls forever). On each cycle it:

1. Scans `/share/frame/incoming` for settled `<image>` + `<image>.meta.json`
   pairs dropped there by any ingest channel — today that's just the
   `frame-uploader` add-on, but the contract stays channel-agnostic so more
   could write here later without any change to this add-on.
2. Normalizes each photo (honors EXIF rotation, downscales to the configured
   long-edge max, re-encodes JPEG, strips EXIF) and writes it to
   `/config/www/frame/photos/`.
3. Updates `/config/www/frame/manifest.json`.

Because `/config/www/` is Home Assistant's own `www` folder, the output is
automatically served at **`/local/frame/`** — point the `frame/` display PWA's
`VITE_MANIFEST_URL` / `VITE_PHOTOS_BASE` at your HA URL + that path.

## Options

| Option | Type | Default | Description |
|--------|------|---------|--------------|
| `poll_interval` | int (5–3600) | `30` | Seconds between scans of `incoming/`. |
| `max_long_edge` | int (320–4000) | `1280` | Downscale so the long edge is at most this many px (never upscales). |
| `jpeg_quality` | int (50–100) | `85` | Re-encode quality for the output JPEG. |

Changing an option and clicking **Save** restarts the add-on with the new
value — no rebuild needed (options aren't baked into the image).

## Shared paths (this add-on's `map:`)

| Container path | HA volume | Mode | Purpose |
|---|---|---|---|
| `/share/frame/incoming` | `share` | rw | Reads ingest drops; deletes/quarantines them after processing. |
| `/config/www/frame` | `homeassistant_config`, `path: /config` | rw | Writes `photos/` + `manifest.json`. |

Both directories are created automatically on startup if missing.

## Install / reload as a local add-on

1. Copy this whole `frame-pipeline/` folder into your HAOS local add-ons
   location (see [`../README.md`](../README.md) — the exact path is `/addons/frame-pipeline/`
   on current Home Assistant OS, confirmed against the official add-on
   developer docs; **verify it on your system** with the note there).
2. Settings → Add-ons → **Add-on Store** → ⋮ (top-right) → **Check for
   updates** (or **Reload**). A "frame-os Pipeline Processor" card appears
   under **Local add-ons**.
3. Open it → **Install** → set options if you want non-default values →
   **Start**. Enable **Start on boot** (should already default on via
   `boot: auto`).
4. Check the **Log** tab: you should see `frame-pipeline starting` followed by
   the resolved paths and tunables.

## Iterating on the code

`src/processor.py` is edited directly here — there's no separate canonical
copy to sync in from anywhere else. After an edit, **bump `version` in
`config.yaml`** (e.g. `1.0.0` → `1.0.1`) — the Supervisor only rebuilds an
add-on's image when its version changes. Re-copy the folder to your HAOS
add-ons location (or `git pull` there if you deploy via a git-backed local
checkout), then **Check for updates** → **Update** in the Add-on Store.

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
