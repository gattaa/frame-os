# CLAUDE.md — frame-os

Guidance for Claude (and humans) working in this repo. Read this before
touching anything. This file is the source of truth for the project's intent
and its hard constraints.

## What this is

`frame-os` replaces the stock **Frameo** software on an **AGFAPHOTO** digital
photo frame with a self-hosted PWA.

- **Hardware:** 10" panel, **1280×800**, capacitive touch, white plastic
  bezel.
- **Runtime:** an **ancient** Android System WebView (≈ **Chrome 60**). This is
  the single most important constraint in the whole project. See "Hard
  constraints" below.
- **Shell:** the PWA runs fullscreen via **Fully Kiosk Browser** (kiosk mode,
  auto-start, screen-on rules, etc.).
- **What it shows:** a fullscreen **photo slideshow** with a **control-center
  overlay** — clock, home battery %, live power draw, energy generated/used
  today, and **AC controls** — all pulled from a **self-hosted Home Assistant**.

## Hard constraints (do not violate)

These are not preferences. Shipping code that breaks them means a blank screen
on the actual device.

### 1. The WebView is ancient (~Chrome 60)
- **Vite build target must be `["es2015", "chrome61"]`** and the build must use
  **`@vitejs/plugin-legacy` with polyfills** enabled.
- **No optional chaining (`?.`) or nullish coalescing (`??`) in shipped
  output** unless it has been transpiled away. Authoring with modern syntax is
  fine *only* because the toolchain lowers it — verify the emitted `dist/`
  bundle, not just the source.
- Assume **no** modern DOM/JS APIs without checking: no `IntersectionObserver`
  guarantees, no `ResizeObserver`, no top-level `await`, no `structuredClone`,
  no `fetch` AbortController niceties. Polyfill or avoid.
- **`backdrop-filter` is NOT safe.** Do not rely on it. The **default** for any
  overlay/control bar is a **semi-opaque solid bar** (e.g. an `rgba()` fill).
  Blur via `backdrop-filter` may be added **only** as progressive enhancement
  behind an `@supports (backdrop-filter: blur(…))` guard, and the UI must look
  correct and legible without it.
- Test mental model: "would this run in Chrome 60?" If unsure, don't ship it.

### 2. Offline-first and fully self-hosted
- The frame may have flaky or no internet. The app must **work offline** once
  loaded: cache the shell, degrade gracefully when Home Assistant is
  unreachable, never hard-fail on a network error.
- **No third-party runtime dependencies / no CDNs / no external calls.**
  Everything is served from the local network (the frame, the HA box, or the
  uploader sidecar). Build-time dev dependencies are fine; runtime ones that
  phone out are not.
- **Data lives in plain files** (a `photos/` folder, a `thumbs/` folder, and a
  `manifest.json`). No database is required for the display path. Each
  manifest entry is `{id, file, uploader, caption, channel, ts, w, h,
  favourite, thumb}` — `favourite` (bool, default `false`) and `thumb` (the
  matching filename in `thumbs/`, a <=300px gallery-grid copy) back the PWA's
  gallery/favourites feature; both are additive and must be tolerated-missing
  by any reader.

### 3. Architecture contract (channel-agnostic pipeline)
This is the central design rule. Keep these boundaries clean:

```
  ingest channels  ──drop files──▶  data/incoming/  ──▶  PROCESSOR  ──writes──▶  data/photos/ + data/thumbs/ + data/manifest.json  ──reads──▶  DISPLAY (PWA)
   (uploader,                                            (the ONLY                                                                       (read-only)
    future...)                                            writer to
                                                          photos/, thumbs/,
                                                          & manifest)
```

- **The display only ever READS** `data/photos/`, `data/thumbs/`, and
  `data/manifest.json`. It never writes them and never talks to ingest
  channels directly. The one exception is `POST /favourite`, a narrow,
  purpose-built endpoint on the processor's own add-on (not a generic write
  API) that the display calls to flip one manifest entry's `favourite` flag —
  the processor remains the only thing that actually touches the file.
- **The processor is the ONLY writer** to `data/photos/`, `data/thumbs/`, and
  `data/manifest.json`. It handles resize/orientation/format normalization,
  thumbnail generation, dedupe, ordering, and manifest generation.
- **Ingest channels only drop raw files into `data/incoming/`.** They know
  nothing about photo processing or the manifest format.
- **Channels must be swappable** without touching the processor or the PWA.
  Adding/removing a channel (the HA uploader, a future Telegram bot or USB
  import, etc.) must not require changes outside that channel's own folder.
  The only channel today is the HA uploader (`channel: "ha"` in meta.json);
  the contract stays channel-agnostic so more can be added later.

### 4. Secrets
- Secrets live in **`.env`** (`frame/`), **`ha/secrets.yaml`** (Home
  Assistant), or an add-on's own Supervisor-managed `options` (`haos-addons/`
  — e.g. `upload_token`), and are **gitignored**/never baked into an image.
  Commit `.env.example` templates, never real values. No tokens,
  URLs-with-creds, or chat IDs in tracked files.

### 5. Aesthetic
- **Clean, modern, light theme** as the default, to match the white frame
  bezel.
- A **separate dark "night" theme** for low-light hours.
- Calm, legible, high-contrast typography; the overlay must be readable at a
  glance from across a room.

## Repo layout

```
frame-os/
├── frame/          # the PWA (Vite + TS) — the display. READ-ONLY consumer.
├── pipeline/       # dev-only mock-data generator for frame/ — NOT the processor
├── ha/             # Home Assistant YAML snippets (dashboards, sensors, automations)
├── haos-addons/    # ingest + processing, as a single HAOS add-on — see below
└── data/           # runtime data (gitignored contents)
    ├── incoming/   # ingest drops raw files here
    ├── photos/     # processor output; the display reads this
    └── thumbs/     # processor output (gallery thumbnails); the display reads this
    # data/manifest.json is generated by the processor (gitignored)
```

HAOS is the only place ingest and processing actually run — there is no
separate docker-compose/bare-process deployment to keep in sync.
`haos-addons/frame-uploader/src/` is the single source of truth for that
service, edited directly there.

### Component responsibilities
- **frame/** — Vite + TypeScript PWA. Slideshow + control-center overlay +
  full-screen gallery. Reads `manifest.json` + `photos/` + `thumbs/` (the
  gallery grid loads `thumbs/`, never full-size photos). Talks to Home
  Assistant for live tiles, and to the frame-uploader add-on's `POST
  /favourite` for the heart toggle/gallery favouriting. Must obey every item
  in "Hard constraints".
- **pipeline/** — a local dev tool only: a **mock-data generator** for
  developing `frame/` without real ingest. It is not the processor and has no
  relationship to the HAOS runtime.
- **haos-addons/frame-uploader/** — a **FastAPI** sidecar, packaged as a Home
  Assistant OS add-on, that serves its own upload page (reached via HA
  Ingress, typically pinned as a sidebar panel) so photos can be added
  straight from Home Assistant. It is the sole writer of `data/incoming/`,
  and immediately processes each upload it saves (the channel-agnostic
  processor logic — EXIF rotation, downscale, re-encode, strip EXIF,
  thumbnail generation, manifest update — runs inline as a Python function,
  not a separate service) into `data/photos/` + `data/thumbs/` +
  `data/manifest.json`, the only writer of all three. It also serves `POST
  /favourite` (flips one entry's flag, same auth as uploads) and a one-shot
  thumbnail backfill (CLI flag + automatic startup check) for entries
  published before `thumb` existed. It's the sole ingest channel today
  (`channel: "ha"`), but the incoming/ contract stays channel-agnostic — a
  future channel could still drop files there, though it would need its own
  way to get them processed since there's no longer an always-on poller
  watching that directory.
- **ha/** — YAML snippets for Home Assistant (sensors, AC controls,
  dashboard/Lovelace config). Secrets via `ha/secrets.yaml` (gitignored).

## Conventions & workflow

- **Tech:** `frame/` is TypeScript + Vite. `pipeline/` and the `haos-addons/`
  services are Python (FastAPI for the uploader). Keep each component
  self-contained in its folder.
- **Don't cross the contract boundaries** described above. If a change seems to
  require the display to write files, or an ingest channel to know about the
  manifest, stop — that's a design smell.
- **Verify the build target.** When working in `frame/`, confirm modern syntax
  is actually lowered in `dist/` before claiming Chrome-60 compatibility.
- **Secrets stay out of git.** Add `.env.example` templates; never commit real
  values.

## Status

Scaffold only. No features implemented yet — folder skeleton, docs, and the
architecture contract are in place. Build features in later passes.
