# frame-os Uploader

A Home Assistant OS add-on wrapping `src/app.py`. This is an **ingest
channel**: it only ever writes into `/share/frame/incoming` — never
`photos/` or `manifest.json`. See [`../../CLAUDE.md`](../../CLAUDE.md) for
the full architecture contract. HAOS is the only place this project runs, so
`src/app.py` is the **single source of truth** for the sidecar — it isn't
synced in from anywhere else.

## API

- `GET /` — the upload page (self-contained HTML/CSS/JS, no external assets).
  Its JS posts to `POST /upload` on a *relative* path so it keeps working
  under HA Ingress's per-add-on path prefix.
- `POST /upload` — multipart form: `file` (the image), `uploader` (free-text
  name, typed into the page's "Your name" field and remembered in the
  browser's `localStorage`), `caption` (optional). Validates the bytes really
  are a decodable image, enforces `max_upload_mb`, rate-limits to
  `rate_limit_per_min` per client. Writes `incoming/<id>.<ext>` +
  `incoming/<id>.<ext>.meta.json` (`{uploader, caption, channel: "ha", ts}`) —
  the sidecar is written **before** the image is revealed, so the processor
  never sees an image without its meta. Returns
  `200 {"id": "...", "channel": "ha", "status": "queued"}`.
  See "Security model" below for when `X-Upload-Token` is required.
- `GET /health` — liveness probe.

No HA auth/user API is involved in attribution — the name typed into the page
rides along the `page → sidecar → incoming/ → processor → manifest.json`
path as an ordinary form field, and the frame shows it as the sender chip.

The add-on serves its own upload UI at `GET /` — no Lovelace card or dashboard
config needed. Reached via HA Ingress, it can live as a **sidebar panel**
(see "Show in sidebar" below) or simply be opened from Settings → Add-ons →
frame-os Uploader → **Open Web UI**.

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

`src/app.py` is edited directly here — there's no separate canonical copy to
sync in from anywhere else. `requirements.txt` in this folder is maintained
by hand (Alpine-appropriate; notably plain `uvicorn`, not the `[standard]`
extra — see the comment at the top of that file for why).

After an edit, bump `version` in `config.yaml` and **Check for updates** →
**Update** in the Add-on Store (Supervisor only rebuilds on a version bump).
