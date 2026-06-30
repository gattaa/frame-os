# uploader/ — FastAPI sidecar + Lovelace upload card (ingest channel)

Lets photos be added straight from the Home Assistant dashboard.

**Role in the architecture contract:** this is an **ingest channel**. It writes
**only** into `../data/incoming/`. It does no image processing and knows nothing
about `photos/` or `manifest.json`. It must be swappable without touching the
processor or the PWA. See [`../CLAUDE.md`](../CLAUDE.md).

## Parts

- **FastAPI sidecar** — a small local service that accepts uploaded files and
  drops them into `../data/incoming/`.
- **Custom Lovelace upload card** (`lovelace/`) — a dashboard card that posts
  files to the sidecar.

## Contract rules

- Writes `incoming/` only. Never writes `photos/` or `manifest.json`.
- Self-hosted; no external calls. Secrets via `.env` (see `.env.example`).

## Status

Scaffold only — no service or card code yet.
