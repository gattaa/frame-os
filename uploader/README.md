# uploader/ — FastAPI sidecar + upload page (ingest channel)

The **primary ingest channel**: it lets family add photos straight from the
Home Assistant app. A small FastAPI sidecar (Dockerized, behind your existing
nginx, or as the `frame-uploader` HAOS add-on) serves its own upload page and
drops uploads into the shared `incoming/` directory.

**Role in the architecture contract:** an ingest channel. It writes **only**
into `../data/incoming/`, never `photos/` or `manifest.json`, and knows nothing
about processing. See [`../CLAUDE.md`](../CLAUDE.md).

```
upload page (GET /)  ──multipart POST /upload──▶  sidecar  ──writes──▶  incoming/
   uploader = name typed on the page                (FastAPI)        <id>.<ext>
   caption  = free text                                              <id>.<ext>.meta.json
                                                                        {uploader, caption,
                                                                         channel:"ha", ts}
                                          ...then the pipeline processor takes over.
```

As the HAOS add-on, the page is opened via HA Ingress — typically pinned as a
sidebar panel — so it's same-origin with `/upload` and needs no separate host
or token from the browser. See
[`../haos-addons/frame-uploader/DOCS.md`](../haos-addons/frame-uploader/DOCS.md)
for the full security model.

## Attribution

The page has a plain "Your name" text field (remembered in the browser's
`localStorage` between visits) sent as the `uploader` form field. The sidecar
writes it into the `meta.json` sidecar next to the image, and the processor
copies it straight into `manifest.json`, which the frame shows as the sender
chip. No HA auth/user API is involved — attribution rides along the
`page → sidecar → incoming/ → processor → display` path as ordinary data.

## Sidecar API

- `GET /` — the upload page (self-contained HTML/CSS/JS, no external assets).
  Posts to `POST /upload` on a *relative* path so it works unmodified behind
  HA Ingress's per-add-on path prefix or the mapped-port fallback.
- `POST /upload` — multipart form: `file` (the image), `uploader`, `caption`.
  - Validates the bytes really are an image (Pillow, full decode — not just a
    header check, so a truncated upload is rejected instead of silently
    quarantined later) and enforces `MAX_UPLOAD_MB`.
  - Rate-limited to `RATE_LIMIT_PER_MIN` uploads per client per rolling 60s
    window (`429` beyond that).
  - Writes `incoming/<id>.<ext>` + `incoming/<id>.<ext>.meta.json`
    (`channel: "ha"`). The sidecar is written **before** the image is revealed,
    so the processor never sees an image without its meta.
  - Returns `200 {"id": "...", "channel": "ha", "status": "queued"}`.
  - `X-Upload-Token` header, required only if `UPLOAD_TOKEN` is set **and**
    the request isn't ingress-verified (`RESTRICT_TO_SUPERVISOR` unset — the
    plain docker-compose/mapped-port deployments below). Ingress-origin
    requests are already authenticated by the HA session, so the bundled
    upload page's JS never sends this header — see
    [`../haos-addons/frame-uploader/DOCS.md`](../haos-addons/frame-uploader/DOCS.md)
    for the full reasoning.
- `GET /health` — liveness probe.

Config is env-driven — see [`.env.example`](./.env.example): `INCOMING_DIR`,
`MAX_UPLOAD_MB`, `ALLOWED_ORIGINS` (CORS), `UPLOAD_TOKEN`, `RATE_LIMIT_PER_MIN`
(default 12), and `RESTRICT_TO_SUPERVISOR` (only relevant when run as the
Home Assistant OS add-on behind Ingress — see below; leave unset/false here).

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

## Open the upload page

Just visit the sidecar's origin — `GET /` serves the page, no dashboard config
needed. Running as the HAOS add-on, that's via **Open Web UI** on the add-on's
Info tab, or as a pinned sidebar panel (see
[`../haos-addons/frame-uploader/DOCS.md`](../haos-addons/frame-uploader/DOCS.md)).

## nginx reverse-proxy route (mapped-port fallback only)

If you're not using the HAOS add-on's ingress, expose the sidecar under your
own domain:

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

With this route, `https://ha.example.com/frame-upload/` serves the upload
page and `https://ha.example.com/frame-upload/upload` is the POST target
(the page's relative `upload` path resolves there automatically). Since this
path isn't ingress-verified, `UPLOAD_TOKEN` is real protection here — the
bundled page never sends it, so gate this route behind your own auth (e.g.
HA's own login in front of the proxy, or a client that adds
`X-Upload-Token` itself) if you use this fallback.

## Running as a Home Assistant OS add-on

As an alternative to the Docker/nginx setup above, [`../haos-addons/frame-uploader/`](../haos-addons/frame-uploader/)
wraps this same sidecar as a Supervisor-managed add-on reachable via **HA
Ingress** — no port opened on the host at all, and it's the recommended way to
run this: the upload page can be pinned as an HA sidebar panel with zero
dashboard config. See that folder's `DOCS.md` for the full security model and
a fully-tested mapped-port fallback if you'd rather not use ingress.

## Status

Sidecar + upload page implemented, superseding the earlier Lovelace-card
approach. The upload page is a self-contained HTML/CSS/JS response with no
external assets; the sidecar is a small FastAPI container.
