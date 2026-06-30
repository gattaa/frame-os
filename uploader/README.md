# uploader/ — FastAPI sidecar + Lovelace upload card (ingest channel)

The **primary ingest channel**: it lets family add photos straight from the
Home Assistant app. A small FastAPI sidecar (Dockerized, behind your existing
nginx) receives uploads from a custom Lovelace card and drops them into the
shared `incoming/` directory.

**Role in the architecture contract:** an ingest channel. It writes **only**
into `../data/incoming/`, never `photos/` or `manifest.json`, and knows nothing
about processing. See [`../CLAUDE.md`](../CLAUDE.md).

```
HA app (Lovelace card)  ──multipart POST──▶  sidecar  ──writes──▶  incoming/
   uploader = hass.user.name                  (FastAPI)        <id>.<ext>
   caption  = free text                                        <id>.<ext>.meta.json
                                                                  {uploader, caption,
                                                                   channel:"ha", ts}
                                          ...then the pipeline processor takes over.
```

## Why this preserves attribution without touching HA internals

The card reads `hass.user.name` in the browser and sends it as a plain form
field. The sidecar writes it into the `meta.json` sidecar next to the image.
The processor copies that straight into `manifest.json`, and the frame shows it
as the sender chip. Nothing is stored in HA, no HA auth/user API is involved —
attribution rides along the `card → sidecar → incoming/ → processor → display`
path as ordinary data.

## Sidecar API

- `POST /upload` — multipart form: `file` (the image), `uploader`, `caption`.
  - Validates the bytes really are an image (Pillow) and enforces
    `MAX_UPLOAD_MB`.
  - Writes `incoming/<id>.<ext>` + `incoming/<id>.<ext>.meta.json`
    (`channel: "ha"`). The sidecar is written **before** the image is revealed,
    so the processor never sees an image without its meta.
  - Returns `200 {"id": "...", "channel": "ha", "status": "queued"}`.
  - Optional `X-Upload-Token` header if `UPLOAD_TOKEN` is set.
- `GET /health` — liveness probe.

Config is env-driven — see [`.env.example`](./.env.example): `INCOMING_DIR`,
`MAX_UPLOAD_MB`, `ALLOWED_ORIGINS` (CORS), `UPLOAD_TOKEN`.

## Run it

### Docker (recommended)

```bash
cd uploader
docker compose up -d --build
```

The one thing that matters: the `volumes:` entry in
[`docker-compose.yml`](./docker-compose.yml) must mount the **same** `incoming/`
directory the processor watches:

```yaml
volumes:
  - ../data/incoming:/data/incoming   # host path <-> container INCOMING_DIR
```

Set `ALLOWED_ORIGINS` to your HA origin and (optionally) `UPLOAD_TOKEN`.

### Directly (dev)

```bash
cd uploader
pip install -r requirements.txt
INCOMING_DIR=../data/incoming python app.py
# POST test:
curl -F file=@photo.jpg -F uploader=alice -F caption=hi http://127.0.0.1:8077/upload
```

## Install the Lovelace card

1. **Drop the card JS** where HA serves static files:
   `<config>/www/frame-os-upload-card.js`
   (copy from `uploader/lovelace/frame-os-upload-card.js`). HA serves
   `<config>/www/` at `/local/`.

2. **Register the resource** — Settings → Dashboards → ⋮ → Resources → Add:
   - URL: `/local/frame-os-upload-card.js`
   - Type: **JavaScript Module**
   (or in YAML mode, under `lovelace.resources:`
   `- url: /local/frame-os-upload-card.js` / `type: module`).

3. **Add the card** to a dashboard:

   ```yaml
   type: custom:frame-os-upload-card
   sidecar_url: https://ha.example.com/frame-upload   # your proxied sidecar URL
   title: Add a photo
   # token: "your-secret"   # only if UPLOAD_TOKEN is set on the sidecar
   ```

## nginx reverse-proxy route

Expose the sidecar under your HA domain (so CORS is same-origin and the app can
reach it). Point `sidecar_url` at this path:

```nginx
# within your existing HTTPS server { } for ha.example.com
location /frame-upload/ {
    proxy_pass http://127.0.0.1:8077/;   # or http://uploader:8077/ on a shared docker network
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 30m;            # >= MAX_UPLOAD_MB
}
```

With this route, `POST https://ha.example.com/frame-upload/upload` reaches the
sidecar, and `sidecar_url` in the card is `https://ha.example.com/frame-upload/upload`.

## Status

Sidecar + card implemented. The card is dependency-free vanilla JS (loads on any
HA companion app); the sidecar is a small FastAPI container.
