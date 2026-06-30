# pipeline/ — processor + mock-data generator

The heart of the architecture contract.

**Role:** the **processor** is the ONLY component allowed to write
`../data/photos/` and `../data/manifest.json`. It watches `../data/incoming/`
(where ingest channels drop raw files), then normalizes and publishes for the
display.

See [`../CLAUDE.md`](../CLAUDE.md) for the full contract.

## Responsibilities

- **Processor** (channel-agnostic):
  - Watch / scan `../data/incoming/` for new raw files.
  - Normalize: orientation (EXIF), resize/fit for **1280×800**, format, dedupe.
  - Write processed images into `../data/photos/`.
  - (Re)generate `../data/manifest.json` describing the slideshow set.
  - It must work regardless of *which* channel produced the incoming file.
- **Mock-data generator:**
  - Produce fake photos + a valid `manifest.json` so the `frame/` PWA can be
    developed without any real ingest channel running.

## Contract rules

- Reads `incoming/`, writes `photos/` + `manifest.json`. Nothing else writes
  those outputs.
- Knows nothing about Telegram, the uploader, or any specific channel — it only
  sees files in `incoming/`.

## Planned stack

Python. No DB — plain files only.

## Status

Scaffold only — no processor code yet.
