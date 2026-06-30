# telegram/ — bootstrap bot (test harness + fallback channel)

A standalone Telegram bot used to (1) **bootstrap/test** the pipeline early
(easiest way to get real photos flowing) and (2) act as a **fallback ingest
channel**.

**Role in the architecture contract:** this is an **ingest channel**. It writes
**only** into `../data/incoming/`. It knows nothing about image processing or
the manifest, and is swappable without touching the processor or the PWA. See
[`../CLAUDE.md`](../CLAUDE.md).

## Contract rules

- Receives photos via Telegram, drops the raw files into `../data/incoming/`.
- Never writes `photos/` or `manifest.json`.
- Bot token + allowed chat IDs live in `.env` (see `.env.example`), gitignored.

## Status

Scaffold only — no bot code yet.
