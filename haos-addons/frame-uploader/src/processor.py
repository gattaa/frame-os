#!/usr/bin/env python3
"""frame-os photo processor.

The single source of truth for the photo contract. It is the ONLY component
allowed to write ``data/photos/`` and ``data/manifest.json``. Since the
frame-uploader merge, this module is imported directly by ``app.py`` and run
inline on every upload — it is no longer a separate polling service. See
DOCS.md for why.

Contract
--------
The uploader (the sole writer of ``incoming/``) drops two files per photo:

  1. an image                         e.g.  sunset.jpg
  2. a sidecar  ``<image>.meta.json`` e.g.  sunset.jpg.meta.json
     containing {"uploader", "caption", "channel", "ts"}

``process_one()`` normalizes a single freshly-written image (honor EXIF
rotation, downscale to <=MAX_LONG_EDGE px on the long edge, re-encode JPEG
q~JPEG_QUALITY, strip EXIF), writes it to ``photos/<id>.jpg``, and updates
``manifest.json`` — a list of:

  {id, file, uploader, caption, channel, ts, w, h}

``id`` is a content hash of the *source* image, so reruns never duplicate and
the same photo dropped twice collapses to one entry.

This file also keeps a one-shot, directory-scanning CLI (``run_once`` /
``main``) for manually reprocessing anything stuck in ``incoming/`` (e.g.
after a crash mid-write) — it is not a running service, just an occasional
manual command. See README.md for the full contract and meta.json schema.
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
# Env vars let the HAOS add-on wrapper configure these without touching the
# file/manifest contract. CLI flags (see main()) still take precedence over
# env vars, which take precedence over the defaults below.

def _env_int(name: str, default: int) -> int:
    v = os.getenv(name)
    if not v:
        return default
    try:
        return int(v)
    except ValueError:
        return default


MAX_LONG_EDGE = _env_int("MAX_LONG_EDGE", 1280)   # downscale so the long edge is at most this many px
JPEG_QUALITY = _env_int("JPEG_QUALITY", 85)       # re-encode quality
SETTLE_SECONDS = 2.0      # ignore files touched more recently than this (in-flight writers)
NO_META_GRACE = 120.0     # after this long with no sidecar, process with default meta + warn
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

        ``INCOMING_DIR`` and ``OUTPUT_DIR`` are the two env vars the add-on
        sets (``OUTPUT_DIR`` is the parent of ``photos/`` and
        ``manifest.json``, mirroring this repo's ``data/`` layout) — see
        ../DOCS.md.
        """
        # repo root: this file lives at haos-addons/frame-uploader/src/processor.py
        root = Path(__file__).resolve().parent.parent.parent.parent
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


def _default_meta(image: Path) -> Dict[str, Any]:
    return {
        "uploader": "unknown",
        "caption": "",
        "channel": "unknown",
        "ts": _iso(image.stat().st_mtime),
    }


def _normalize_meta(raw: Any, defaults: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        return defaults
    meta = dict(defaults)
    for key in ("uploader", "caption", "channel", "ts"):
        if raw.get(key) not in (None, ""):
            meta[key] = raw[key]
    return meta


def load_meta(image: Path, now: float) -> Optional[Dict[str, Any]]:
    """Load and normalize the sidecar meta for ``image`` during a directory scan.

    Returns a dict on success. Returns ``None`` to mean "skip for now" — either
    the sidecar is missing but the image is still within the grace window, or
    the sidecar exists but is not yet valid JSON (likely mid-write). Used by
    the scanning CLI, where the file may have been dropped by anything and
    could still be mid-write; the inline upload path uses
    ``load_meta_immediate`` instead, since it wrote the file itself.
    """
    meta_path = meta_path_for(image)
    defaults = _default_meta(image)

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

    return _normalize_meta(raw, defaults)


def load_meta_immediate(image: Path) -> Dict[str, Any]:
    """Load sidecar meta for an image the caller just finished writing itself
    (uploader always writes the sidecar before revealing the image — see
    app.py's ``_drop_into_incoming``), so there's no settle wait or "not ready
    yet" case to handle."""
    meta_path = meta_path_for(image)
    defaults = _default_meta(image)
    if not meta_path.exists():
        log.warning("no sidecar for %s; using defaults", image.name)
        return defaults
    try:
        raw = json.loads(meta_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        log.warning("sidecar for %s not parseable (%s); using defaults", image.name, exc)
        return defaults
    return _normalize_meta(raw, defaults)


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


# --- Inline single-file path (used by app.py on every upload) --------------

def process_one(cfg: Config, image: Path) -> Optional[Dict[str, Any]]:
    """Process one freshly-written image immediately and update the manifest.

    No settle wait: the caller (app.py) just finished writing both the image
    and its sidecar itself, so there's no risk of reading a partial file.
    Returns the manifest entry (existing or newly published), or ``None`` if
    the image was corrupt/undecodable (quarantined in that case — this
    shouldn't happen in practice since app.py already validated the bytes
    decode fully before saving, but is handled defensively).
    """
    cfg.photos.mkdir(parents=True, exist_ok=True)
    cfg.manifest.parent.mkdir(parents=True, exist_ok=True)

    manifest = load_manifest(cfg.manifest)
    index: Dict[str, Dict[str, Any]] = {e["id"]: e for e in manifest if "id" in e}

    try:
        src = image.read_bytes()
    except OSError as exc:
        log.error("could not read %s: %s", image.name, exc)
        return None
    if not src:
        log.warning("empty upload file %s", image.name)
        return None

    eid = content_id(src)

    # Idempotent: already published and file present -> drop the source, reuse the entry.
    if eid in index and index[eid].get("file") and (cfg.photos / index[eid]["file"]).exists():
        log.info("duplicate %s -> %s (already published)", image.name, eid)
        remove_source(image)
        return index[eid]

    meta = load_meta_immediate(image)

    try:
        jpeg, w, h = process_image(src)
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        log.error("corrupt/undecodable %s (%s); quarantining", image.name, exc)
        quarantine(image)
        return None

    out_name = f"{eid}.jpg"
    atomic_write_bytes(cfg.photos / out_name, jpeg)
    entry = {
        "id": eid,
        "file": out_name,
        "uploader": meta["uploader"],
        "caption": meta["caption"],
        "channel": meta["channel"],
        "ts": meta["ts"],
        "w": w,
        "h": h,
    }
    index[eid] = entry
    remove_source(image)

    new_manifest = sorted(index.values(), key=lambda e: (str(e.get("ts", "")), e["id"]))
    atomic_write_json(cfg.manifest, new_manifest)
    log.info("published %s -> %s (%dx%d, %s)", image.name, out_name, w, h, meta["channel"])
    return entry


# --- Directory-scanning path (manual reprocessing CLI only) ---------------

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
    """Process all settled incoming images. Returns the number published.

    This is the manual-reprocessing path (``python processor.py``), for when
    something is stuck in ``incoming/`` (e.g. after a crash mid-upload). Normal
    uploads never reach this function — they go through ``process_one``
    inline in app.py.
    """
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


# --- CLI (manual reprocessing only — not a running service) ----------------

def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="frame-os photo processor — one-shot manual reprocessing of incoming/"
    )
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

    cfg.incoming.mkdir(parents=True, exist_ok=True)
    cfg.photos.mkdir(parents=True, exist_ok=True)
    cfg.manifest.parent.mkdir(parents=True, exist_ok=True)

    published = run_once(cfg)
    log.info("done: %d new photo%s", published, "" if published == 1 else "s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
