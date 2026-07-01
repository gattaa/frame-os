# frame-os Uploader

Wraps `uploader/app.py` (see [`../../uploader/README.md`](../../uploader/README.md))
as a Home Assistant OS add-on. This is an **ingest channel**: it only ever
writes into `/share/frame/incoming` — never `photos/` or `manifest.json`. See
[`../../CLAUDE.md`](../../CLAUDE.md) for the full architecture contract.

## Security: what's shipped

The uploader is reachable from your public reverse proxy, so it must never be
a bare open POST endpoint. This add-on ships **two layers together**, not one
instead of the other:

1. **HA Ingress** (`ingress: true`, `ingress_port: 8099`, no `ports:` key in
   `config.yaml`) — no port is opened on the host at all. The only way to
   reach the container is through the Supervisor's ingress proxy. Per Home
   Assistant's own ingress requirements, the add-on **must** deny anything not
   from the Supervisor's fixed internal address `172.30.32.2` — `run.sh` sets
   `RESTRICT_TO_SUPERVISOR=true`, which `app.py`'s middleware enforces (see
   `../../uploader/app.py`, function `_restrict_to_supervisor`).
2. **A mandatory shared secret** (`upload_token`, required, minimum 16 chars —
   the add-on **refuses to start** without one; see `config.yaml`'s
   `match(^.{16,}$)` schema and the matching check in `run.sh`). This is
   defense-in-depth on top of ingress, and it's also the **exact mechanism**
   you fall back to if you disable ingress and map a port instead (see
   "Alternative: mapped port" below).

Also always on regardless of transport: full image decode validation (not
just a header sniff — rejects truncated uploads), a size cap (`max_upload_mb`),
and a per-client rate limit (`rate_limit_per_min`).

**Honesty note:** the ingress transport is implemented per Home Assistant's
documented add-on/ingress conventions (config.yaml flags, the `172.30.32.2`
restriction, and the Lovelace card's `hassio/addons/<slug>/info` lookup for
`ingress_url`), but it was **not exercised against a live Home Assistant
Supervisor** while building this — there was no HAOS instance available in
that environment. Test it on your own install before relying on it. If
anything about the ingress path doesn't work for you, the mapped-port fallback
below is a complete, independently-working alternative — same app, same
security checks, just a different door.

## Options

| Option | Type | Default | Description |
|--------|------|---------|--------------|
| `upload_token` | password (≥16 chars, **required**) | *(blank — you must set it)* | Shared secret the Lovelace card must send as `X-Upload-Token`. Generate one with `openssl rand -hex 32` (or any 16+ char random string) and paste it here **and** into the card's `token:` config. |
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
   enforce this).
4. Start it. Check the **Log** tab for `frame-uploader starting on :8099
   (ingress only)`.
5. Its **Info** tab shows the exact **slug** Supervisor assigned (needed for
   the card's `ingress_slug:` — see below; it may or may not be prefixed with
   `local_` depending on your Supervisor version).

## Install the Lovelace card

The card JS ships in [`lovelace/frame-os-upload-card.js`](./lovelace/frame-os-upload-card.js)
(synced from `../../uploader/lovelace/`, same file — not part of this add-on's
Docker build, it's a frontend resource).

1. Copy `lovelace/frame-os-upload-card.js` to `<HA config>/www/frame-os-upload-card.js`
   (HA serves `<config>/www/` at `/local/`).
2. Settings → Dashboards → ⋮ → Resources → Add: URL `/local/frame-os-upload-card.js`,
   type **JavaScript Module**.
3. Add the card to a dashboard:

   ```yaml
   type: custom:frame-os-upload-card
   ingress_slug: frame_uploader   # from the add-on's Info tab — verify yours!
   token: "<the same upload_token you set above>"
   title: Add a photo
   ```

## Alternative: mapped port (skip ingress)

If ingress gives you trouble, or you'd rather manage exposure yourself behind
your own reverse proxy:

1. Edit `config.yaml`: delete the `ingress:` / `ingress_port:` /
   `panel_icon:` lines, and add:
   ```yaml
   ports:
     8099/tcp: 8099
   ports_description:
     8099/tcp: "frame-os uploader HTTP API"
   ```
2. Bump `version` and reinstall (see "Iterating" below).
3. Proxy `https://ha.example.com/frame-upload/` → the add-on's host:8099 in
   your nginx config (see the canonical `../../uploader/README.md` for a ready
   nginx `location` block).
4. Configure the card with **Option B** instead:
   ```yaml
   type: custom:frame-os-upload-card
   sidecar_url: https://ha.example.com/frame-upload/upload
   token: "<the same upload_token>"
   ```
   `RESTRICT_TO_SUPERVISOR` no longer applies in this mode (only ingress
   traffic originates from `172.30.32.2`); the shared-secret token is what's
   protecting the endpoint here, same as the plain docker-compose deployment.

## Iterating on the code

`src/app.py` is a **synced copy** of the canonical `uploader/app.py` (see
[`../sync.sh`](../sync.sh)). `requirements.txt` in this folder is maintained
separately (Alpine-appropriate; notably plain `uvicorn`, not the `[standard]`
extra — see the comment at the top of that file for why).

```bash
./haos-addons/sync.sh   # re-copies uploader/app.py + the Lovelace card in
```

Then bump `version` in `config.yaml` and **Check for updates** → **Update** in
the Add-on Store (Supervisor only rebuilds on a version bump).
