# ha/ — Home Assistant snippets

YAML snippets for the self-hosted Home Assistant that backs the control-center
overlay: sensors (home battery %, live power, energy today), the **AC controls**
the frame exposes, and any Lovelace/dashboard config.

**Role:** Home Assistant is the live-data source the `frame/` PWA reads for its
overlay tiles, and the target for AC control actions. It is not part of the
photo ingest/processing path. See [`../CLAUDE.md`](../CLAUDE.md).

## Secrets

- Real values go in **`ha/secrets.yaml`**, which is **gitignored**.
- Commit only the example template (`secrets.yaml.example`) and snippet configs
  that reference `!secret` keys — never the values.

## Status

Scaffold only — no snippets yet.
