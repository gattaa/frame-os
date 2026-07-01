# frame-os Pipeline Processor

Wraps `pipeline/processor.py` (see [`../../pipeline/README.md`](../../pipeline/README.md)
for the full contract) as a Home Assistant OS add-on. It's the **only writer**
of `photos/` + `manifest.json` — see [`../../CLAUDE.md`](../../CLAUDE.md) for
why that boundary matters.

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

This add-on's `src/processor.py` is a **synced copy** of the canonical
`pipeline/processor.py` (see [`../sync.sh`](../sync.sh)). To pick up an edit:

```bash
./haos-addons/sync.sh              # re-copies pipeline/processor.py in
```

Then **bump `version` in `config.yaml`** (e.g. `1.0.0` → `1.0.1`) — the
Supervisor only rebuilds an add-on's image when its version changes. Re-copy
the folder to your HAOS add-ons location (or `git pull` there if you deploy
via a git-backed local checkout), then **Check for updates** → **Update** in
the Add-on Store.

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
