# pipeline/ — processor + mock-data generator

The **single source of truth for the photo contract**. The processor is the
**only** component allowed to write `../data/photos/` and
`../data/manifest.json`. Everything else either drops files into `incoming/`
(ingest channels) or only reads `photos/` + `manifest.json` (the PWA). See
[`../CLAUDE.md`](../CLAUDE.md) for the project-wide contract.

## The contract

Any ingest channel drops **two files** into `../data/incoming/` per photo:

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

## Running

```bash
pip install -r requirements.txt

# One-shot: process whatever is waiting, then exit.
python processor.py

# Loop: poll incoming/ forever (default every 30s).
python processor.py --loop
python processor.py --loop --interval 15

# Verbose / custom paths.
python processor.py -v
python processor.py --incoming /path/in --photos /path/out --manifest /path/manifest.json
```

Defaults resolve to the repo's `data/` dir (`data/incoming`, `data/photos`,
`data/manifest.json`) regardless of the working directory.

### Configuring paths without CLI flags (env vars)

A wrapper (e.g. a Home Assistant OS add-on — see
[`../haos-addons/frame-pipeline/`](../haos-addons/frame-pipeline/)) can set
these instead of passing `--incoming`/`--photos`/`--manifest`. Precedence is
**CLI flag > env var > repo-relative default**; nothing about the file/manifest
contract changes, only where the files live.

| Env var | Effect |
|---|---|
| `INCOMING_DIR` | overrides the `incoming/` dir |
| `OUTPUT_DIR` | parent of the output — `photos/` and `manifest.json` resolve to `$OUTPUT_DIR/photos` and `$OUTPUT_DIR/manifest.json` |
| `POLL_INTERVAL` | default for `--interval` (seconds) |
| `MAX_LONG_EDGE` | default for the long-edge downscale cap (px) |
| `JPEG_QUALITY` | default re-encode quality |

### Tunables

Constants at the top of `processor.py`: `MAX_LONG_EDGE` (1280, env-overridable),
`JPEG_QUALITY` (85, env-overridable), `SETTLE_SECONDS` (2), `NO_META_GRACE`
(120), `POLL_INTERVAL` (30, env-overridable), `ID_LEN` (16).

## Mock data (run the PWA with zero backend)

`gen_mock.py` writes everything the `frame/` PWA needs, the same way the real
processor would:

```bash
python gen_mock.py
```

Produces under `../data/`:

- `photos/<id>.jpg` — **6 labeled 1280×800** placeholder photos
- `manifest.json` — a valid manifest pointing at them
- `mock-entities.json` — fake Home Assistant values: **battery %**, **live
  power**, **energy today**, and an **AC climate entity** (shaped like real HA
  state objects, so the PWA's mapping code is exercised the same way).

All of `data/`'s contents are gitignored; regenerate any time.

## Running as a Home Assistant OS add-on

To have the Supervisor manage this (auto-restart, survives reboots) instead of
running it as a bare process or in docker-compose, see
[`../haos-addons/frame-pipeline/`](../haos-addons/frame-pipeline/).
