#!/usr/bin/env python3
"""frame-os pipeline processor.

The single source of truth for the photo contract. It is the ONLY component
allowed to write ``data/photos/`` and ``data/manifest.json``.

Contract
--------
Ingest channels drop two files into ``incoming/`` for each photo:

  1. an image                         e.g.  sunset.jpg
  2. a sidecar  ``<image>.meta.json`` e.g.  sunset.jpg.meta.json
     containing {"uploader", "caption", "channel", "ts"}

The processor scans ``incoming/``, normalizes each settled image (honor EXIF
rotation, downscale to <=1280px on the long edge, re-encode JPEG q~85, strip
EXIF), writes it to ``photos/<id>.jpg``, and maintains ``manifest.json`` as a
list of:

  {id, file, uploader, caption, channel, ts, w, h}

``id`` is a content hash of the *source* image, so reruns never duplicate and
the same photo dropped twice collapses to one entry. Manifest entries whose
backing file has disappeared from ``photos/`` are pruned.

Run it two ways::

    python processor.py            # one-shot: process whatever is waiting, exit
    python processor.py --loop     # poll forever (default every 30s)

See README.md for the full contract and meta.json schema.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import logging
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from PIL import Image, ImageOps, UnidentifiedImageError

# --- Tunables ---------------------------------------------------------------
# Env vars let a wrapper (e.g. a Home Assistant add-on; see ../haos-addons/)
# configure these without touching the file/manifest contract. CLI flags (see
# main()) still take precedence over env vars, which take precedence over the
# defaults below.

def _env_int(name: str, default: int) -> int:
    v = os.getenv(name)
    if not v:
        return default
    try:
        return int(v)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    v = os.getenv(name)
    if not v:
        return default
    try:
        return float(v)
    except ValueError:
        return default


MAX_LONG_EDGE = _env_int("MAX_LONG_EDGE", 1280)   # downscale so the long edge is at most this many px
JPEG_QUALITY = _env_int("JPEG_QUALITY", 85)       # re-encode quality
SETTLE_SECONDS = 2.0      # ignore files touched more recently than this (in-flight writers)
NO_META_GRACE = 120.0     # after this long with no sidecar, process with default meta + warn
POLL_INTERVAL = _env_float("POLL_INTERVAL", 30.0)  # --loop poll cadency (seconds)
ID_LEN = 16               # hex chars of the content hash kept as the id

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".tif", ".heic"}
META_SUFFIX = ".meta.json"
REJECTED_DIRNAME = "_rejected"  # corrupt/undecodable files are quarantined here

log = logging.getLogger("processor")


# --- Config ---------------------------------------------------------------

@dataclass
class Config:
    incoming: Path
    photos: Path
    manifest: Path

    @classmethod
    def from_args(cls, args: argparse.Namespace) -> "Config":
        """Resolve paths with precedence: CLI flag > env var > repo-relative default.

        ``INCOMING_DIR`` and ``OUTPUT_DIR`` are the two env vars a wrapper sets
        (``OUTPUT_DIR`` is the parent of ``photos/`` and ``manifest.json``,
        mirroring this repo's ``data/`` layout) — see ../haos-addons/README.md.
        """
        root = Path(__file__).resolve().parent.parent  # repo root (parent of pipeline/)
        data_default = root / "data"
        incoming_env = os.getenv("INCOMING_DIR")
        output_env = os.getenv("OUTPUT_DIR")

        if args.incoming:
            incoming = Path(args.incoming)
        elif incoming_env:
            incoming = Path(incoming_env)
        else:
            incoming = data_default / "incoming"

        if args.photos:
            photos = Path(args.photos)
        elif output_env:
            photos = Path(output_env) / "photos"
        else:
            photos = data_default / "photos"

        if args.manifest:
            manifest = Path(args.manifest)
        elif output_env:
            manifest = Path(output_env) / "manifest.json"
        else:
            manifest = data_default / "manifest.json"

        return cls(incoming.resolve(), photos.resolve(), manifest.resolve())


# --- Helpers --------------------------------------------------------------

def content_id(data: bytes) -> str:
    """Stable id = first ID_LEN hex chars of the sha256 of the source bytes."""
    return hashlib.sha256(data).hexdigest()[:ID_LEN]


def meta_path_for(image: Path) -> Path:
    """`sunset.jpg` -> `sunset.jpg.meta.json` (sidecar keyed on full filename)."""
    return image.with_name(image.name + META_SUFFIX)


def is_settled(path: Path, now: float) -> bool:
    """True if the file hasn't been modified in the last SETTLE_SECONDS."""
    try:
        return (now - path.stat().st_mtime) >= SETTLE_SECONDS
    except OSError:
        return False


def file_age(path: Path, now: float) -> float:
    try:
        return now - path.stat().st_mtime
    except OSError:
        return 0.0


def load_meta(image: Path, now: float) -> Optional[Dict[str, Any]]:
    """Load and normalize the sidecar meta for ``image``.

    Returns a dict on success. Returns ``None`` to mean "skip for now" — either
    the sidecar is missing but the image is still within the grace window, or
    the sidecar exists but is not yet valid JSON (likely mid-write).
    """
    meta_path = meta_path_for(image)
    defaults = {
        "uploader": "unknown",
        "caption": "",
        "channel": "unknown",
        "ts": _iso(image.stat().st_mtime),
    }

    if not meta_path.exists():
        if file_age(image, now) < NO_META_GRACE:
            log.debug("no sidecar for %s yet; waiting", image.name)
            return None
        log.warning("no sidecar for %s after grace; using defaults", image.name)
        return defaults

    if not is_settled(meta_path, now):
        log.debug("sidecar for %s still settling", image.name)
        return None

    try:
        raw = json.loads(meta_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        log.debug("sidecar for %s not parseable yet (%s); will retry", image.name, exc)
        return None

    if not isinstance(raw, dict):
        log.warning("sidecar for %s is not an object; using defaults", image.name)
        return defaults

    meta = dict(defaults)
    for key in ("uploader", "caption", "channel", "ts"):
        if raw.get(key) not in (None, ""):
            meta[key] = raw[key]
    return meta


def _iso(epoch: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


def process_image(data: bytes) -> Tuple[bytes, int, int]:
    """Normalize raw image bytes -> (jpeg_bytes, width, height).

    Honors EXIF orientation, downscales to MAX_LONG_EDGE on the long edge
    (never upscales), flattens to RGB, and re-encodes JPEG with EXIF stripped.
    """
    with Image.open(io.BytesIO(data)) as img:
        img = ImageOps.exif_transpose(img)  # bake in rotation, then we drop EXIF

        if img.mode in ("RGBA", "LA", "P"):
            # Flatten transparency onto white so JPEG (no alpha) looks right.
            img = img.convert("RGBA")
            background = Image.new("RGB", img.size, (255, 255, 255))
            background.paste(img, mask=img.split()[-1])
            img = background
        elif img.mode != "RGB":
            img = img.convert("RGB")

        img.thumbnail((MAX_LONG_EDGE, MAX_LONG_EDGE), Image.LANCZOS)  # downsize only
        w, h = img.size

        out = io.BytesIO()
        img.save(out, format="JPEG", quality=JPEG_QUALITY, optimize=True)
        # No exif= passed -> EXIF is not carried into the output.
        return out.getvalue(), w, h


def atomic_write_bytes(path: Path, data: bytes) -> None:
    tmp = path.with_name(path.name + f".tmp.{os.getpid()}")
    tmp.write_bytes(data)
    os.replace(tmp, path)  # atomic within the same filesystem


def atomic_write_json(path: Path, obj: Any) -> None:
    text = json.dumps(obj, indent=2, ensure_ascii=False) + "\n"
    atomic_write_bytes(path, text.encode("utf-8"))


def load_manifest(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, list):
            return data
        log.warning("manifest is not a list; starting fresh")
    except (json.JSONDecodeError, OSError) as exc:
        log.warning("could not read manifest (%s); starting fresh", exc)
    return []


def quarantine(image: Path) -> None:
    """Move an undecodable image + its sidecar out of the scan path."""
    rejected = image.parent / REJECTED_DIRNAME
    rejected.mkdir(exist_ok=True)
    for src in (image, meta_path_for(image)):
        if src.exists():
            try:
                os.replace(src, rejected / src.name)
            except OSError as exc:
                log.error("could not quarantine %s: %s", src.name, exc)


def remove_source(image: Path) -> None:
    """Delete a successfully-processed image and its sidecar from incoming/."""
    for src in (image, meta_path_for(image)):
        try:
            src.unlink(missing_ok=True)
        except OSError as exc:
            log.warning("could not remove %s: %s", src.name, exc)


# --- Core -----------------------------------------------------------------

def iter_incoming_images(incoming: Path) -> List[Path]:
    if not incoming.exists():
        return []
    out = []
    for p in sorted(incoming.iterdir()):
        if not p.is_file():
            continue
        if p.name.endswith(META_SUFFIX):
            continue
        if p.suffix.lower() in IMAGE_SUFFIXES:
            out.append(p)
    return out


def run_once(cfg: Config) -> int:
    """Process all settled incoming images. Returns the number published."""
    cfg.photos.mkdir(parents=True, exist_ok=True)
    cfg.manifest.parent.mkdir(parents=True, exist_ok=True)

    manifest = load_manifest(cfg.manifest)
    index: Dict[str, Dict[str, Any]] = {e["id"]: e for e in manifest if "id" in e}

    # 1. Prune entries whose backing file is gone. Require a non-empty "file":
    #    a malformed entry without one must NOT match the photos directory
    #    (cfg.photos / "" resolves to the dir itself, which always exists).
    before = len(index)
    index = {
        eid: e for eid, e in index.items()
        if e.get("file") and (cfg.photos / e["file"]).exists()
    }
    pruned = before - len(index)
    if pruned:
        log.info("pruned %d manifest entr%s with missing files",
                 pruned, "y" if pruned == 1 else "ies")

    # 2. Process incoming.
    now = time.time()
    published = 0
    for image in iter_incoming_images(cfg.incoming):
        if not is_settled(image, now):
            log.debug("skip %s (still settling)", image.name)
            continue

        try:
            src = image.read_bytes()
        except OSError as exc:
            log.warning("could not read %s: %s", image.name, exc)
            continue
        if not src:
            log.debug("skip %s (empty)", image.name)
            continue

        eid = content_id(src)

        # Idempotent: already published and file present -> drop the source, move on.
        if eid in index and index[eid].get("file") and (cfg.photos / index[eid]["file"]).exists():
            log.info("duplicate %s -> %s (already published)", image.name, eid)
            remove_source(image)
            continue

        meta = load_meta(image, now)
        if meta is None:
            continue  # not ready this cycle

        try:
            jpeg, w, h = process_image(src)
        except (UnidentifiedImageError, OSError, ValueError) as exc:
            log.error("corrupt/undecodable %s (%s); quarantining", image.name, exc)
            quarantine(image)
            continue

        out_name = f"{eid}.jpg"
        atomic_write_bytes(cfg.photos / out_name, jpeg)
        index[eid] = {
            "id": eid,
            "file": out_name,
            "uploader": meta["uploader"],
            "caption": meta["caption"],
            "channel": meta["channel"],
            "ts": meta["ts"],
            "w": w,
            "h": h,
        }
        remove_source(image)
        published += 1
        log.info("published %s -> %s (%dx%d, %s)",
                 image.name, out_name, w, h, meta["channel"])

    # 3. Write manifest atomically (sorted oldest-first for a stable slideshow)
    #    only when something actually changed — avoids needless flash writes and
    #    an mtime bump every idle cycle (which would defeat conditional-GET).
    if published or pruned or not cfg.manifest.exists():
        new_manifest = sorted(index.values(), key=lambda e: (str(e.get("ts", "")), e["id"]))
        atomic_write_json(cfg.manifest, new_manifest)
        log.info("manifest now has %d entr%s",
                 len(new_manifest), "y" if len(new_manifest) == 1 else "ies")
    return published


def run_loop(cfg: Config, interval: float) -> None:
    log.info("loop mode: polling %s every %.0fs (Ctrl-C to stop)", cfg.incoming, interval)
    while True:
        try:
            run_once(cfg)
        except Exception:  # never let one bad cycle kill the daemon
            log.exception("unexpected error in processing cycle")
        time.sleep(interval)


# --- CLI ------------------------------------------------------------------

def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="frame-os photo pipeline processor")
    parser.add_argument("--loop", action="store_true",
                        help="run continuously, polling every --interval seconds")
    parser.add_argument("--interval", type=float, default=POLL_INTERVAL,
                        help=f"poll interval for --loop (default {POLL_INTERVAL:.0f}s)")
    parser.add_argument("--incoming", help="override incoming/ dir")
    parser.add_argument("--photos", help="override photos/ dir")
    parser.add_argument("--manifest", help="override manifest.json path")
    parser.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )

    cfg = Config.from_args(args)
    log.info("incoming=%s", cfg.incoming)
    log.info("photos  =%s", cfg.photos)
    log.info("manifest=%s", cfg.manifest)

    # Create the shared dirs eagerly so they exist even before the first photo
    # arrives (matters for wrappers like the HAOS add-ons, which mount these
    # paths and expect them to be present as soon as the processor starts).
    cfg.incoming.mkdir(parents=True, exist_ok=True)
    cfg.photos.mkdir(parents=True, exist_ok=True)
    cfg.manifest.parent.mkdir(parents=True, exist_ok=True)

    if args.loop:
        try:
            run_loop(cfg, args.interval)
        except KeyboardInterrupt:
            log.info("stopped")
        return 0

    published = run_once(cfg)
    log.info("done: %d new photo%s", published, "" if published == 1 else "s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
