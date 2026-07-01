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
- **Data lives in plain files** (a `photos/` folder + a `manifest.json`). No
  database is required for the display path.

### 3. Architecture contract (channel-agnostic pipeline)
This is the central design rule. Keep these boundaries clean:

```
  ingest channels  ──drop files──▶  data/incoming/  ──▶  PROCESSOR  ──writes──▶  data/photos/ + data/manifest.json  ──reads──▶  DISPLAY (PWA)
   (uploader,                                            (the ONLY                                                       (read-only)
    future...)                                            writer to
                                                          photos/ &
                                                          manifest)
```

- **The display only ever READS** `data/photos/` and `data/manifest.json`. It
  never writes them and never talks to ingest channels directly.
- **The processor is the ONLY writer** to `data/photos/` and
  `data/manifest.json`. It handles resize/orientation/format normalization,
  dedupe, ordering, and manifest generation.
- **Ingest channels only drop raw files into `data/incoming/`.** They know
  nothing about photo processing or the manifest format.
- **Channels must be swappable** without touching the processor or the PWA.
  Adding/removing a channel (the HA uploader, a future Telegram bot or USB
  import, etc.) must not require changes outside that channel's own folder.
  The only channel today is the HA uploader (`channel: "ha"` in meta.json);
  the contract stays channel-agnostic so more can be added later.

### 4. Secrets
- All secrets live in **`.env`** (apps) and **`ha/secrets.yaml`** (Home
  Assistant), and are **gitignored**. Commit `.env.example` templates, never
  real values. No tokens, URLs-with-creds, or chat IDs in tracked files.

### 5. Aesthetic
- **Clean, modern, light theme** as the default, to match the white frame
  bezel.
- A **separate dark "night" theme** for low-light hours.
- Calm, legible, high-contrast typography; the overlay must be readable at a
  glance from across a room.

## Repo layout

```
frame-os/
├── frame/      # the PWA (Vite + TS) — the display. READ-ONLY consumer.
├── pipeline/   # the processor + a mock-data generator. ONLY writer of photos/+manifest.
├── uploader/   # FastAPI sidecar + self-served upload page (the ingest channel)
├── ha/         # Home Assistant YAML snippets (dashboards, sensors, automations)
└── data/       # runtime data (gitignored contents)
    ├── incoming/   # channels drop raw files here
    └── photos/     # processor output; the display reads this
    # data/manifest.json is generated by the processor (gitignored)
```

### Component responsibilities
- **frame/** — Vite + TypeScript PWA. Slideshow + control-center overlay. Reads
  `manifest.json` + `photos/`. Talks to Home Assistant for live tiles. Must
  obey every item in "Hard constraints".
- **pipeline/** — the channel-agnostic **processor** (sole writer of
  `photos/` + `manifest.json`) plus a **mock-data generator** for developing
  the frame without real ingest.
- **uploader/** — a **FastAPI** sidecar that serves its own upload page
  (reached via HA Ingress, typically pinned as a sidebar panel) so photos can
  be added straight from Home Assistant. It is just an ingest channel: it
  writes only into `data/incoming/`. It's the sole ingest channel today
  (`channel: "ha"`), but the contract is channel-agnostic — nothing stops a
  future channel being added in its own folder without touching this one.
- **ha/** — YAML snippets for Home Assistant (sensors, AC controls,
  dashboard/Lovelace config). Secrets via `ha/secrets.yaml` (gitignored).

## Conventions & workflow

- **Tech:** `frame/` is TypeScript + Vite. `pipeline/` and `uploader/` are
  Python (FastAPI for the uploader). Keep each component self-contained in its
  folder.
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
