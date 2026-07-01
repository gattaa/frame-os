# haos-addons/ — Home Assistant OS add-ons

HAOS is the only place this project actually runs — there's no separate
docker-compose/bare-process deployment to keep in sync, so each add-on's
`src/` **is** the canonical source for that service, edited directly here.

**Nothing about the file/manifest contract changes.** See
[`../CLAUDE.md`](../CLAUDE.md) for the contract itself (channels write
`incoming/`; the processor is the sole writer of `photos/` +
`manifest.json`; the display only reads them). Each add-on folder is a
**self-contained Docker build context** with its own `config.yaml`,
`Dockerfile`, `run.sh`, and `src/`.

```
haos-addons/
├── frame-pipeline/         # processor, loop mode, no ports
└── frame-uploader/         # FastAPI sidecar + self-served upload page, ingress (no port)
```

The only thing outside `haos-addons/` is [`../pipeline/gen_mock.py`](../pipeline/README.md),
a local dev tool for developing the `frame/` PWA without any real ingest —
it has nothing to do with the HAOS runtime.

## The shared path contract

Every add-on reads these from its own options/env — never hardcoded — and
creates them on startup if missing:

| Env var | Path | Who | Mode |
|---|---|---|---|
| `INCOMING_DIR` | `/share/frame/incoming` | both | `frame-pipeline` rw (reads+deletes/quarantines); `frame-uploader` rw (writes only) |
| `OUTPUT_DIR` | `/config/www/frame` | `frame-pipeline` only | rw — writes `photos/` + `manifest.json`, auto-served by Home Assistant at **`/local/frame/`** |

`/share` and `/config` are Home Assistant's own shared-storage and config
volumes — mapping into them (rather than each add-on's private `/data`) is
what lets both containers see the same `incoming/` folder, and lets the
processor's output land somewhere Home Assistant itself serves as static
files. `frame-uploader` is the sole ingest channel today; the folder is
structured so another one could be added later without touching
`frame-pipeline`.

## Deploy

1. **Copy into your HAOS local add-ons location.** Home Assistant OS watches a
   folder for local add-ons, one subfolder per add-on:
   ```bash
   cp -r haos-addons/frame-pipeline haos-addons/frame-uploader /addons/
   ```
   **Path note (verify on your system):** per Home Assistant's current
   official add-on developer docs (the "Apps" tutorial, since add-ons were
   renamed "apps" in the docs), the local add-ons directory is **`/addons`**,
   reachable via the **SSH & Terminal** add-on or the **Samba** add-on's
   `addons` network share — *not* a nested `/addons/local/` subfolder. That's
   what this README assumes. Some older guides/setups reference
   `/addons/local/` instead; if `cp -r ... /addons/` doesn't make your add-ons
   show up under "Local add-ons" after a Store reload, check whether your
   instance instead expects `/addons/local/` and try that path. A quick way to
   confirm on your own system: SSH in and run `ls /addons` (or `ls
   /addons/local` if the former doesn't exist) — whichever one already
   contains folders/is writable is the one Supervisor is watching.
2. **Reload the Add-on Store**: Settings → Add-ons → Add-on Store → ⋮
   (top-right) → **Check for updates**. Both should appear under
   **Local add-ons**.
3. Install and configure each one — see its own `DOCS.md`
   ([`frame-pipeline/DOCS.md`](./frame-pipeline/DOCS.md),
   [`frame-uploader/DOCS.md`](./frame-uploader/DOCS.md)) for options, install
   steps, and — for the uploader — the ingress-vs-mapped-port security
   tradeoff.

## Iterating

Edit `src/processor.py` / `src/app.py` directly in each add-on's own folder —
they're the only copy. After an edit, **bump `version`** in the affected
add-on's `config.yaml` — Supervisor only rebuilds an add-on's image when its
version string changes. Re-copy (or `git pull`, if you deploy via a git
checkout at the add-ons location) and **Check for updates** → **Update** in
the Store.

Each add-on's own `requirements.txt` is maintained by hand (Alpine/musl-
appropriate pins, which can differ from a generic `pip install` — e.g. the
uploader drops uvicorn's `[standard]` extra; see its own comment for why).

## Multi-arch builds: `build.yaml` and a deprecation note

Per the task's request, each add-on is built for **`amd64` and `aarch64`** via
a `build.yaml` referencing the official
`ghcr.io/home-assistant/{arch}-base-python` images — confirmed to exist for
both architectures at tag `3.12-alpine3.24` at the time this was written
(checked directly against the `ghcr.io` registry API, not assumed).

**Worth knowing:** Home Assistant's current add-on developer docs state that,
as of Supervisor 2026.04.0, `build.yaml` is **deprecated but still
functional** — "Supervisor still reads `build.yaml` if it's present and
populates the image build arguments with values read from this file. This
will produce warnings and eventually be removed in the future." The platform's
newer preferred approach is a bare `FROM` in the Dockerfile pointing at a
**unified multi-platform manifest image** (Docker BuildKit resolves the right
architecture automatically) — e.g. `ghcr.io/home-assistant/base-python`
(no arch prefix) also exists today, confirmed at tag `3.12-alpine3.23`.

`build.yaml` was used here because that's what was explicitly asked for and it
is still fully functional today — just expect a deprecation warning in the
build log, and know that migrating later is a small, mechanical change:
delete `build.yaml`, and in each `Dockerfile` replace
```dockerfile
ARG BUILD_FROM
FROM ${BUILD_FROM}
```
with
```dockerfile
FROM ghcr.io/home-assistant/base-python:3.12-alpine3.23
```
(pin whatever tag you want at that point — check `ghcr.io/home-assistant/base-python`'s
current tags, since floating-tag availability shifts over time).

## What's verified vs. not (read this before relying on ingress)

Built and checked in this project's dev sandbox (no live Home Assistant OS
available there):
- Both canonical services' env-driven path config, dir auto-creation, the
  uploader's rate limiter, and its Supervisor-only IP restriction middleware —
  all exercised directly with real HTTP requests.
- Every `config.yaml` — parsed and structurally validated (see below).
- Every `Dockerfile`/`run.sh` — syntax-checked; **not** actually built or run**
  as a container** (this sandbox has no usable Docker daemon — attempted and
  confirmed unavailable, not skipped).
- The `ghcr.io/home-assistant/{arch}-base-python:3.12-alpine3.24` base images
  — confirmed to exist and be pullable (via the registry's anonymous token
  API), for both `amd64` and `aarch64`.

**Not verified against a live Supervisor** (none available here): the actual
`docker build` of each add-on, and the exact local-addon slug HA assigns
(`frame_uploader` vs. `local_frame_uploader`) — these follow documented
conventions but should be checked on your own HAOS install before you rely on
them. See `frame-uploader/DOCS.md` for the fully-tested mapped-port fallback
if ingress doesn't behave as documented for you.
