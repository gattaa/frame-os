# frame/ — the PWA (display)

The fullscreen Progressive Web App that runs on the AGFAPHOTO frame via Fully
Kiosk: a photo **slideshow** with a **control-center overlay** (clock, weather,
home battery % + charge/discharge status, house power draw, one AC badge per
room) sourced from Home Assistant. The overlay is transparent and dims to a
subtle resting state when idle, waking to full opacity on touch, so it never
competes with the photo.

**Role in the architecture contract:** READ-ONLY consumer. It only reads
`../data/photos/`, `../data/thumbs/`, and `../data/manifest.json`, and Home
Assistant for live tiles. It never writes those files and never talks to
ingest channels directly — the one exception is `POST /favourite` on the
frame-uploader add-on, a narrow write to a single manifest flag, not a
generic file write. See [`../CLAUDE.md`](../CLAUDE.md).

## Running

```bash
npm install
npm run dev       # http://localhost:5173 — runs against pipeline mock data
npm run build     # type-check + production build (emits the legacy bundle)
npm run preview   # serve the built dist/ (also serves ../data at /data/*)
```

`npm run dev` and `npm run preview` mount the repo's `../data/` directory at
`/data/*` (see `vite.config.ts`), so the app reads `manifest.json`,
`mock-entities.json`, and `photos/` with no extra server. Generate mock data
first with `python ../pipeline/gen_mock.py`.

In dev (and any build made with `VITE_USE_MOCK=true`) the app runs entirely
against mock JSON — **no live Home Assistant needed**.

## The ancient-WebView build (non-negotiable)

The device WebView is ≈ **Chrome 60**, which has no `<script type=module>`
support, so it loads the **nomodule legacy bundle**.

- `vite.config.ts` sets `build.target = ["es2015","chrome61"]` and uses
  **`@vitejs/plugin-legacy`** (`targets: ["chrome >= 60"]`, polyfills on). The
  legacy + polyfill chunks are what actually run on the frame.
  - (Vite prints "plugin-legacy overrode 'build.target'" — expected; the plugin
    owns the legacy target. The legacy bundle is verified to contain no
    untranspiled `?.`/`??`.)
- **`backdrop-filter` is not used as a load-bearing style.** The AC badges/panel
  use a solid semi-opaque fill; blur is added only behind an
  `@supports (backdrop-filter: …)` guard and the UI is legible without it.
- **Light theme default** (matches the white bezel) + a **dark night theme**
  via `[data-theme]`, switched by `theme.ts` off HA's
  `input_boolean.frame_night_mode` (same boolean HA uses to drive screen
  brightness, so the two stay in lockstep).

## Layout

| File | Responsibility |
|------|----------------|
| `src/config.ts` | All env-specific config: entity IDs (`BATTERY_PCT`, `BATTERY_STATUS`, `HOUSE_POWER`, `CLIMATES` — one or more `climate.*` entities), HA base URL + token and the frame-uploader `UPLOADER` base URL + token (loaded at runtime, see below), the kiosk `PANEL` backend config, the `USE_MOCK`/`DEV` switch, data paths (including `THUMBS_BASE`), behaviour tunables. |
| `src/photos.ts` | Reads `manifest.json`, preloads, crossfades every ~12s. Images are fully static — `object-fit:cover` by default, or `contain` with pure-white letterbox/pillarbox bars when a photo's aspect ratio deviates significantly from the 1280x800 screen. The always-on rotation is every `favourite` photo plus the 10 newest non-favourites, shuffled together and reshuffled each full pass. Exposes pause/resume/step for the nav controls, `getAllEntries()`/`getCurrentEntry()` for the gallery, and `toggleFavourite()` (optimistic `POST /favourite`, reconciled on response). |
| `src/data.ts` | Subscribes to HA entities via `home-assistant-js-websocket`; mirrors every update to IndexedDB; falls back to last-known on disconnect / offline / mock and flags it **stale**. Never crashes on missing entities. |
| `src/idb.ts` | Tiny promise-based IndexedDB key/value store (hand-written, no dep). |
| `src/format.ts` | Shared `D Mon` date formatting, used by both the clock and photo captions. |
| `src/overlay.ts` | Transparent control-center overlay: clock/date/weather/battery/power top-right, one tappable badge per AC room top-left (tap to expand a setpoint/mode/fan panel, calls HA climate services), prev/pause-play/next/favourite-heart photo controls + a gallery button + a settings gear (brightness/screen-off/force-refresh via the kiosk panel backend) bottom center/right. The nav+gear layer fully fades out on idle and reappears on touch; wakes to full opacity on touch, dims again after inactivity. |
| `src/gallery.ts` | Full-screen, touch-scrollable grid of every photo (loads `thumb`s, not full-size, for WebView performance). Tap a grid item's heart to toggle favourite; tap the photo to open it large with its own favourite toggle + close/back control. Pauses the slideshow's auto-advance while open, resumes on close. |
| `src/theme.ts` | `startTheme()` — light/dark driven by HA `input_boolean.frame_night_mode` (via the data layer). Optionally nudges PWA brightness on transitions. |
| `src/brightness.ts` | `setBrightness(1–255)` / `setScreenOn(bool)` / `forceRefresh()`, behind a small `PanelBackend` interface with `wallpanel`/`fully`/`none` implementations, selected by `VITE_PANEL_BACKEND`. Gated by config so it no-ops in desktop dev. |
| `src/main.ts` | Boot + service-worker registration. |
| `public/sw.js` | Hand-written, Chrome-60-safe service worker (see Offline). |
| `public/manifest.webmanifest` | PWA manifest (fullscreen, landscape). |

## Offline behaviour

`public/sw.js` (registered only for built/preview output, not the dev server):

- **app shell / navigation** → network-first, falls back to cached `index.html`
- **built assets, icons** → cache-first (hashed, immutable)
- **photos** → cache-first
- **`manifest.json` + entities JSON** → network-first, fall back to cache

Cache-fallback responses are tagged `X-From-Cache: 1` so the data layer knows
it's showing last-known values and lights the **stale dot**. A full reload with
the network offline still shows photos + last-known overlay values (verified
end-to-end against the real Chromium build).

## Configuration

Copy `.env.example` → `.env` for a real-device build (kiosk panel backend +
host, data paths, night-mode entity ID). None of it is needed for mock-mode
development.

### Home Assistant connection (HA_URL, HA_TOKEN, entity IDs) + uploader

These values are **not** env vars and are never baked into the build:
`dist/` is committed to a public repo, so anything build-time-injected there
(env vars included) would be publicly visible — and the HA token / uploader
token must never be.

Instead, `config.ts` fetches `<base>runtime-config.json` once at boot (see
`loadRuntimeConfig()` in `src/config.ts`) and uses that instead. This file:

- is **created directly on the HA box**, at `config/www/frame/runtime-config.json`
  (i.e. next to the deployed `dist/`) — **not** in this repo, and never committed.
- follows the shape in [`runtime-config.example.json`](runtime-config.example.json),
  including the optional `uploaderUrl` + `uploaderToken` (the frame-uploader
  add-on's mapped-port URL and its `upload_token`) that enable the gallery's
  favourite toggle — see [`../haos-addons/frame-uploader/DOCS.md`](../haos-addons/frame-uploader/DOCS.md),
  "Alternative: mapped port". Without these two, the heart toggle still
  updates optimistically in the UI but never persists (logged as a warning).
- if missing (e.g. 404, or you never created it), the app falls back to mock
  mode automatically rather than attempting a live connection with no
  credentials.

To go live on a real box: copy `runtime-config.example.json` to
`config/www/frame/runtime-config.json` on the HA host and fill in real values.
