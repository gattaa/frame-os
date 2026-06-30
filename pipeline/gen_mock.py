#!/usr/bin/env python3
"""Generate mock data so the frame/ PWA can run with zero backend.

Produces, under data/:
  - photos/<id>.jpg   : 6 labeled 1280x800 placeholder photos
  - manifest.json     : a valid manifest pointing at them
  - mock-entities.json : fake Home Assistant values (battery %, live power,
                         energy today, and an AC climate entity)

These outputs are written exactly the way the real processor writes them, so
the PWA cannot tell mock data from the real thing.

Usage::

    python gen_mock.py            # write into the repo's data/ dir
    python gen_mock.py --photos ... --manifest ... --entities ...
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import time
from pathlib import Path
from typing import Any, List, Tuple

from PIL import Image, ImageDraw, ImageFont

WIDTH, HEIGHT = 1280, 800
ID_LEN = 16

# (label, caption, uploader, channel, background RGB)
MOCKS: List[Tuple[str, str, str, str, Tuple[int, int, int]]] = [
    ("01", "Sunrise over the hills", "alice", "telegram", (242, 201, 168)),
    ("02", "Beach day with the kids", "bob", "uploader", (168, 213, 226)),
    ("03", "City lights at night", "alice", "telegram", (60, 64, 91)),
    ("04", "Forest hike", "carol", "uploader", (170, 200, 160)),
    ("05", "Birthday dinner", "bob", "telegram", (224, 178, 196)),
    ("06", "First snow", "carol", "uploader", (224, 230, 238)),
]


def _font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    """Best-effort TrueType; falls back to Pillow's bundled bitmap font."""
    for name in ("DejaVuSans-Bold.ttf", "DejaVuSans.ttf", "Arial.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def _luminance(rgb: Tuple[int, int, int]) -> float:
    r, g, b = rgb
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255.0


def make_placeholder(label: str, caption: str, bg: Tuple[int, int, int]) -> bytes:
    img = Image.new("RGB", (WIDTH, HEIGHT), bg)
    draw = ImageDraw.Draw(img)
    fg = (20, 20, 20) if _luminance(bg) > 0.5 else (245, 245, 245)

    # Big centered number.
    big = _font(280)
    text = f"#{label}"
    box = draw.textbbox((0, 0), text, font=big)
    draw.text(((WIDTH - (box[2] - box[0])) / 2, (HEIGHT - (box[3] - box[1])) / 2 - 60),
              text, fill=fg, font=big)

    # Caption strip near the bottom.
    small = _font(40)
    cbox = draw.textbbox((0, 0), caption, font=small)
    draw.text(((WIDTH - (cbox[2] - cbox[0])) / 2, HEIGHT - 140),
              caption, fill=fg, font=small)

    # Dimension hint in the corner.
    tiny = _font(28)
    draw.text((24, 24), f"{WIDTH}x{HEIGHT}", fill=fg, font=tiny)

    out = io.BytesIO()
    img.save(out, format="JPEG", quality=85, optimize=True)
    return out.getvalue()


def atomic_write_bytes(path: Path, data: bytes) -> None:
    tmp = path.with_name(path.name + f".tmp.{os.getpid()}")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def atomic_write_json(path: Path, obj: Any) -> None:
    atomic_write_bytes(path, (json.dumps(obj, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))


def mock_entities() -> dict:
    """Shaped to mirror Home Assistant state objects the PWA will read."""
    return {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "battery": {
            "entity_id": "sensor.home_battery_level",
            "state": 72,
            "unit_of_measurement": "%",
            "friendly_name": "Home Battery",
        },
        "power": {
            "entity_id": "sensor.grid_power",
            "state": -340,  # negative = exporting to grid
            "unit_of_measurement": "W",
            "friendly_name": "Live Power",
        },
        "energy_today": {
            "entity_id": "sensor.solar_energy_today",
            "state": 8.4,
            "unit_of_measurement": "kWh",
            "friendly_name": "Energy Today",
        },
        "ac": {
            "entity_id": "climate.living_room",
            "state": "cool",
            "attributes": {
                "friendly_name": "Living Room AC",
                "current_temperature": 24.5,
                "temperature": 22.0,
                "min_temp": 16,
                "max_temp": 30,
                "target_temp_step": 0.5,
                "hvac_modes": ["off", "cool", "heat", "fan_only", "dry"],
                "hvac_action": "cooling",
                "fan_mode": "auto",
                "fan_modes": ["auto", "low", "medium", "high"],
            },
        },
    }


def main(argv: List[str] | None = None) -> int:
    root = Path(__file__).resolve().parent.parent
    data = root / "data"
    parser = argparse.ArgumentParser(description="generate mock photos + manifest + entities")
    parser.add_argument("--photos", default=str(data / "photos"))
    parser.add_argument("--manifest", default=str(data / "manifest.json"))
    parser.add_argument("--entities", default=str(data / "mock-entities.json"))
    args = parser.parse_args(argv)

    photos = Path(args.photos)
    photos.mkdir(parents=True, exist_ok=True)

    now = time.time()
    manifest = []
    for i, (label, caption, uploader, channel, bg) in enumerate(MOCKS):
        jpeg = make_placeholder(label, caption, bg)
        eid = hashlib.sha256(jpeg).hexdigest()[:ID_LEN]
        fname = f"{eid}.jpg"
        atomic_write_bytes(photos / fname, jpeg)
        # Stagger timestamps so the slideshow has a stable order.
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - (len(MOCKS) - i) * 3600))
        manifest.append({
            "id": eid, "file": fname, "uploader": uploader, "caption": caption,
            "channel": channel, "ts": ts, "w": WIDTH, "h": HEIGHT,
        })

    atomic_write_json(Path(args.manifest), manifest)
    atomic_write_json(Path(args.entities), mock_entities())

    print(f"wrote {len(manifest)} photos -> {photos}")
    print(f"wrote manifest         -> {args.manifest}")
    print(f"wrote mock entities    -> {args.entities}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
