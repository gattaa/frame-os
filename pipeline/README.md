# pipeline/ — mock-data generator (dev only)

`gen_mock.py` writes everything the `frame/` PWA needs to run with **zero
backend**, in exactly the shape the real processor would produce:

```bash
pip install -r requirements.txt
python gen_mock.py
```

Produces under `../data/`:

- `photos/<id>.jpg` — **6 labeled 1280×800** placeholder photos
- `manifest.json` — a valid manifest pointing at them
- `mock-entities.json` — fake Home Assistant values: **battery %**, **battery
  charge/discharge status**, **house power draw**, and an **AC climate
  entity** (shaped like real HA state objects, so the PWA's mapping code is
  exercised the same way).

All of `data/`'s contents are gitignored; regenerate any time.

The real processor is **not** in this folder — it only runs as the
`frame-pipeline` Home Assistant OS add-on (HAOS is the only place this
project actually runs; there's no standalone/docker-compose deployment to
keep in sync). Its source and the full photo/manifest contract are
documented in
[`../haos-addons/frame-pipeline/DOCS.md`](../haos-addons/frame-pipeline/DOCS.md).
`gen_mock.py` duplicates the couple of small id/atomic-write helpers it needs
from that processor (see the comment at the top of `content_id()`) rather
than importing across folders, so this dev tool has no dependency on the
add-on's source living anywhere in particular.
