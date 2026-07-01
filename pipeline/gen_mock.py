#!/usr/bin/env python3
"""Generate mock data so the frame/ PWA can run with zero backend.

Produces, under data/:
  - photos/<id>.jpg   : 6 labeled 1280x800 placeholder photos
  - manifest.json     : a valid manifest pointing at them
  - mock-entities.json : fake Home Assistant values (battery %, battery
                         charge/discharge status, house power draw, 4
                         AC climate entities, and a weather entity)

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

ID_LEN = 16


def content_id(data: bytes) -> str:
    """Stable id = first ID_LEN hex chars of the sha256 of the source bytes.

    Duplicated from the real processor (haos-addons/frame-uploader/src/
    processor.py) rather than imported, so this dev-only mock generator has
    no dependency on it — mock output still needs to be byte-for-byte
    indistinguishable from real processor output, hence the same algorithm.
    """
    return hashlib.sha256(data).hexdigest()[:ID_LEN]


def atomic_write_bytes(path: Path, data: bytes) -> None:
    tmp = path.with_name(path.name + f".tmp.{os.getpid()}")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def atomic_write_json(path: Path, obj: Any) -> None:
    text = json.dumps(obj, indent=2, ensure_ascii=False) + "\n"
    atomic_write_bytes(path, text.encode("utf-8"))


WIDTH, HEIGHT = 1280, 800

# (label, caption, uploader, channel, background RGB)
# "ha" is the only real ingest channel (the HA uploader) — see ../CLAUDE.md.
MOCKS: List[Tuple[str, str, str, str, Tuple[int, int, int]]] = [
    ("01", "Sunrise over the hills", "alice", "ha", (242, 201, 168)),
    ("02", "Beach day with the kids", "bob", "ha", (168, 213, 226)),
    ("03", "City lights at night", "alice", "ha", (60, 64, 91)),
    ("04", "Forest hike", "carol", "ha", (170, 200, 160)),
    ("05", "Birthday dinner", "bob", "ha", (224, 178, 196)),
    ("06", "First snow", "carol", "ha", (224, 230, 238)),
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


BATTERY_STATUSES = ["Charging", "Discharging", "Idle"]

# A sample of met.no's typical `weather.*` states, so re-running this script
# cycles through enough variety to eyeball every icon/label mapping.
WEATHER_STATES = [
    "sunny", "partlycloudy", "cloudy", "rainy",
    "snowy", "fog", "lightning", "windy", "clear-night",
]


def mock_entities() -> dict:
    """Shaped to mirror Home Assistant state objects the PWA will read.

    battery_status cycles through all 3 real-world states (Charging /
    Discharging / Idle) based on the clock, so re-running this script lets
    you visually check every icon/label variant without live HA.
    """
    status = BATTERY_STATUSES[int(time.time()) % len(BATTERY_STATUSES)]
    weather_state = WEATHER_STATES[int(time.time()) % len(WEATHER_STATES)]
    # House power should read sensibly alongside the status: drawing from
    # the grid/battery while discharging, near-zero while idle, negative
    # (i.e. exporting/charging from solar) while charging.
    house_power = {"Charging": -450, "Discharging": 1850, "Idle": 60}[status]
    return {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "battery": {
            "entity_id": "sensor.home_battery_level",
            "state": 72,
            "unit_of_measurement": "%",
            "friendly_name": "Home Battery",
        },
        "batteryStatus": {
            "entity_id": "sensor.solaredge_battery1_status",
            "state": status,
            "friendly_name": "Home Battery Status",
        },
        "housePower": {
            "entity_id": "sensor.house_power",
            "state": house_power,
            "unit_of_measurement": "W",
            "friendly_name": "House Power",
        },
        "weather": {
            "entity_id": "weather.forecast_home",
            "state": weather_state,
            "friendly_name": "Home",
            "attributes": {"temperature": 27},
        },
        "night_mode": {
            "entity_id": "input_boolean.frame_night_mode",
            "state": "off",  # flip to "on" to preview the dark night theme
            "friendly_name": "Frame Night Mode",
        },
        "acs": [
            {
                "entity_id": "climate.camera",
                "state": "off",
                "attributes": {
                    "friendly_name": "Camera",
                    "current_temperature": 25.0,
                    "temperature": None,
                    "min_temp": 16,
                    "max_temp": 30,
                    "target_temp_step": 0.5,
                    "hvac_modes": ["off", "cool", "heat"],
                    "fan_mode": None,
                    "fan_modes": ["auto", "low", "medium", "high"],
                },
            },
            {
                "entity_id": "climate.attico",
                "state": "heat",
                "attributes": {
                    "friendly_name": "Attico",
                    "current_temperature": 20.5,
                    "temperature": 22.0,
                    "min_temp": 16,
                    "max_temp": 30,
                    "target_temp_step": 0.5,
                    "hvac_modes": ["off", "cool", "heat"],
                    "fan_mode": "medium",
                    "fan_modes": ["auto", "low", "medium", "high"],
                },
            },
            {
                "entity_id": "climate.sala",
                "state": "cool",
                "attributes": {
                    "friendly_name": "Sala",
                    "current_temperature": 33.0,
                    "temperature": 24.0,
                    "min_temp": 16,
                    "max_temp": 30,
                    "target_temp_step": 0.5,
                    "hvac_modes": ["off", "cool", "heat", "fan_only", "dry"],
                    "fan_mode": "medium",
                    "fan_modes": ["auto", "low", "medium low", "medium", "medium high", "high"],
                },
            },
            {
                "entity_id": "climate.richelieu",
                "state": "cool",
                "attributes": {
                    "friendly_name": "Richelieu",
                    "current_temperature": 27.5,
                    "temperature": 26.0,
                    "min_temp": 16,
                    "max_temp": 30,
                    "target_temp_step": 0.5,
                    "hvac_modes": ["off", "cool", "heat"],
                    "fan_mode": "auto",
                    "fan_modes": ["auto", "low", "medium", "high"],
                },
            },
        ],
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
        eid = content_id(jpeg)
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
