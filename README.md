# frame-os

Self-hosted software to replace **Frameo** on an **AGFAPHOTO** digital photo
frame. A PWA runs fullscreen (via Fully Kiosk) on the frame's ancient Android
WebView and shows a photo **slideshow** plus a **control-center overlay** —
clock, home battery %, live power, energy today, and AC controls — driven by a
self-hosted **Home Assistant**.

> **Working in this repo?** Read [`CLAUDE.md`](./CLAUDE.md) first. It holds the
> hard constraints (ancient WebView, offline-first, the architecture contract,
> secrets, theming). They are requirements, not suggestions.

## The architecture contract (read this)

The whole design hangs on one rule: **a clean separation between ingest,
processing, and display.**

```
  ingest channels                processor                 display (PWA)
  ┌───────────┐   raw files   ┌─────────────┐   photos/   ┌───────────┐
  │ telegram  │ ───────────▶  │             │ ──────────▶ │           │
  │ uploader  │ ─▶ incoming/  │  the ONLY   │  manifest   │ READ-ONLY │
  │ (future…) │ ───────────▶  │   writer    │ ──────────▶ │           │
  └───────────┘               └─────────────┘             └───────────┘
```

1. **Ingest channels** only ever drop raw files into `data/incoming/`. They
   know nothing about image processing or the manifest format.
2. **The processor** is the **only** thing that writes `data/photos/` and
   `data/manifest.json`. It normalizes images and builds the manifest.
3. **The display** (the PWA) **only reads** `data/photos/` and
   `data/manifest.json`. It never writes them and never talks to channels.

**Channels are swappable.** You can add or remove an ingest channel without
touching the processor or the PWA — that's the point.

## Layout

| Folder       | What it is | Role in the contract |
|--------------|------------|----------------------|
| `frame/`     | The PWA (Vite + TypeScript) — the display | **Reads** `photos/` + `manifest.json` |
| `pipeline/`  | The processor + a mock-data generator | **Only writer** of `photos/` + `manifest.json` |
| `uploader/`  | FastAPI sidecar + custom Lovelace upload card | Ingest channel → writes `incoming/` |
| `telegram/`  | Standalone bootstrap bot (test harness + fallback) | Ingest channel → writes `incoming/` |
| `ha/`        | Home Assistant YAML snippets | Provides live data + AC controls to the PWA |
| `data/`      | Runtime data (gitignored): `incoming/`, `photos/`, `manifest.json` | The files the contract is about |

See each folder's own `README.md` for component-level notes.

## Hard constraints at a glance

- **Ancient WebView (~Chrome 60).** Vite target `["es2015","chrome61"]` +
  `@vitejs/plugin-legacy` with polyfills. No untranspiled `?.`/`??` in shipped
  output. `backdrop-filter` is **not** safe — default to a semi-opaque solid
  bar; blur only as progressive enhancement.
- **Offline-first, fully self-hosted.** No third-party runtime deps, no CDNs.
  Data lives in plain files.
- **Secrets** live in `.env` / `ha/secrets.yaml` and are gitignored. Commit only
  `.env.example` templates.
- **Light theme by default** (to match the white bezel); a separate dark night
  theme.

Full detail and rationale: [`CLAUDE.md`](./CLAUDE.md).

## Status

**Scaffold only.** Folder skeleton, docs, and the architecture contract are in
place. No features built yet.
