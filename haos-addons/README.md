# haos-addons/ — Home Assistant OS add-ons

HAOS is the only place this project actually runs — there's no separate
docker-compose/bare-process deployment to keep in sync, so `frame-uploader/src/`
**is** the canonical source for the whole ingest+process pipeline, edited
directly here.

**Nothing about the file/manifest contract changes.** See
[`../CLAUDE.md`](../CLAUDE.md) for the contract itself (ingest writes
`incoming/`; the processor is the sole writer of `photos/` +
`manifest.json`; the display only reads them). There used to be two add-ons
(`frame-uploader` for ingest, `frame-pipeline` polling `incoming/` to
process) — they've been merged into one, since `frame-uploader` is the only
writer of `incoming/` and can process what it just wrote inline instead of
waiting for a separate poller.

```
haos-addons/
└── frame-uploader/         # FastAPI sidecar: self-served upload page + inline processing, ingress (no port)
```

The only thing outside `haos-addons/` is [`../pipeline/gen_mock.py`](../pipeline/README.md),
a local dev tool for developing the `frame/` PWA without any real ingest —
it has nothing to do with the HAOS runtime.

## The shared path contract

The add-on reads these from its own options/env — never hardcoded — and
creates them on startup if missing:

| Env var | Path | Mode |
|---|---|---|
| `INCOMING_DIR` | `/share/frame/incoming` | rw — writes uploads, deletes/quarantines them after inline processing |
| `OUTPUT_DIR` | `/config/www/frame` | rw — writes `photos/` + `manifest.json`, auto-served by Home Assistant at **`/local/frame/`** |

`/share` and `/config` are Home Assistant's own shared-storage and config
volumes — mapping into `/config` (rather than the add-on's private `/data`)
is what lets the processed output land somewhere Home Assistant itself serves
as static files. `frame-uploader` is the sole ingest channel today; the
contract stays channel-agnostic (see `../CLAUDE.md`) in case another channel
is ever added, though adding one would mean giving it its own way to reach
`incoming/` since there's no longer a separate always-on processor watching it.

## Deploy

1. **Copy into your HAOS local add-ons location.** Home Assistant OS watches a
   folder for local add-ons, one subfolder per add-on:
   ```bash
   cp -r haos-addons/frame-uploader /addons/
   ```
   **Path note (verify on your system):** per Home Assistant's current
   official add-on developer docs (the "Apps" tutorial, since add-ons were
   renamed "apps" in the docs), the local add-ons directory is **`/addons`**,
   reachable via the **SSH & Terminal** add-on or the **Samba** add-on's
   `addons` network share — *not* a nested `/addons/local/` subfolder. That's
   what this README assumes. Some older guides/setups reference
   `/addons/local/` instead; if `cp -r ... /addons/` doesn't make your add-on
   show up under "Local add-ons" after a Store reload, check whether your
   instance instead expects `/addons/local/` and try that path. A quick way to
   confirm on your own system: SSH in and run `ls /addons` (or `ls
   /addons/local` if the former doesn't exist) — whichever one already
   contains folders/is writable is the one Supervisor is watching.
2. **Reload the Add-on Store**: Settings → Add-ons → Add-on Store → ⋮
   (top-right) → **Check for updates**. It should appear under
   **Local add-ons**.
3. Install and configure it — see [`frame-uploader/DOCS.md`](./frame-uploader/DOCS.md)
   for options, install steps, the inline-processing design, and the
   ingress-vs-mapped-port security tradeoff.

## Iterating

Edit `src/app.py` / `src/processor.py` directly in `frame-uploader/`'s own
folder — they're the only copy. After an edit, **bump `version`** in
`config.yaml` — Supervisor only rebuilds an add-on's image when its version
string changes. Re-copy (or `git pull`, if you deploy via a git checkout at
the add-ons location) and **Check for updates** → **Update** in the Store.

`requirements.txt` is maintained by hand (Alpine/musl-appropriate pins, which
can differ from a generic `pip install` — e.g. it drops uvicorn's
`[standard]` extra; see its own comment for why).

## Multi-arch builds: `build.yaml` and a deprecation note

Per the task's request, the add-on is built for **`amd64` and `aarch64`** via
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
delete `build.yaml`, and in the `Dockerfile` replace
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
- The add-on's env-driven path config, dir auto-creation, inline processing,
  rate limiter, and Supervisor-only IP restriction middleware — all exercised
  directly with real HTTP requests.
- `config.yaml` — parsed and structurally validated (see below).
- `Dockerfile`/`run.sh` — syntax-checked; **not** actually built or run **as a
  container** (this sandbox has no usable Docker daemon — attempted and
  confirmed unavailable, not skipped).
- The `ghcr.io/home-assistant/{arch}-base-python:3.12-alpine3.24` base images
  — confirmed to exist and be pullable (via the registry's anonymous token
  API), for both `amd64` and `aarch64`.

**Not verified against a live Supervisor** (none available here): the actual
`docker build` of the add-on, and the exact local-addon slug HA assigns
(`frame_uploader` vs. `local_frame_uploader`) — these follow documented
conventions but should be checked on your own HAOS install before you rely on
them. See `frame-uploader/DOCS.md` for the fully-tested mapped-port fallback
if ingress doesn't behave as documented for you.
