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
  │ uploader  │ ───────────▶  │  the ONLY   │  manifest   │ READ-ONLY │
  │ (future…) │ ─▶ incoming/  │   writer    │ ──────────▶ │           │
  └───────────┘               └─────────────┘             └───────────┘
```

The HA uploader is the sole ingest channel today (every photo's `meta.json`
carries `channel: "ha"`); the contract stays channel-agnostic so more can be
added later without touching the processor or the PWA.

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
| `pipeline/`  | A mock-data generator only (dev tool for `frame/`) | N/A — the real processor lives in `haos-addons/` |
| `ha/`        | Home Assistant YAML snippets | Provides live data + AC controls to the PWA |
| `haos-addons/` | A single Home Assistant OS add-on (`frame-uploader`) — ingest channel + processor combined, the **only** place either runs | **Only writer** of `incoming/`, `photos/`, and `manifest.json` — saves an upload, then processes it inline |
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

## Quickstart (mock data, no Home Assistant required)

```bash
# 1. Generate 6 placeholder photos + manifest.json + mock-entities.json
python pipeline/gen_mock.py

# 2. Run the display against the mock data
cd frame && npm install && npm run dev
```

That's the whole loop for local development. Real ingest only runs as the
`frame-uploader` Home Assistant OS add-on (see `haos-addons/`) — HAOS is the
only place this project actually runs, so there's no standalone processor to
run outside of it. See
[`haos-addons/frame-uploader/DOCS.md`](./haos-addons/frame-uploader/DOCS.md)
for the full `<image>.meta.json`/`manifest.json` schema.

## Status

**All components are implemented and have been smoke-tested end-to-end**
(mock generation → processor → manifest → PWA, and the ingest channel →
processor → PWA), then passed a full code review with the resulting fixes
applied:

| Folder | State |
|--------|-------|
| `pipeline/` | Mock-data generator implemented and verified (dev tool only — see "Status" note above on where the real processor lives). |
| `frame/` | PWA implemented: slideshow, HA-driven overlay + theming, offline service worker. `npm run build` passes with a verified Chrome-60 legacy bundle. |
| `haos-addons/` | The single `frame-uploader` add-on (ingest + inline processing) implemented and verified (idempotent, EXIF-safe downscaling, atomic writes; upload → `incoming/` → inline processing → manifest end-to-end, all within one request). The sole ingest channel today — the contract stays channel-agnostic so more could be added later. Config validated; see its `DOCS.md` for what's verified vs. not (no live HAOS was available to build/run against in this environment). |
| `ha/` | Home Assistant package (night mode, override, brightness/screen automations) implemented and YAML-validated; entity IDs are placeholders pending your real ones. |

**What's left before this runs on the real frame:** swap the placeholder
entity IDs in `ha/packages/frame.yaml` and `frame/.env` for your real Home
Assistant entities (see `ha/README.md`), and install the `haos-addons/`
add-ons on your HAOS instance. No further feature work is planned — see each
folder's own `README.md`/`DOCS.md` for details.
