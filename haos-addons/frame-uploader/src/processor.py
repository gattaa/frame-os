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
q~JPEG_QUALITY, strip EXIF), writes it to ``photos/<id>.jpg``, generates a
small gallery thumbnail (<=MAX_THUMB_EDGE px, JPEG q~THUMB_QUALITY) to
``thumbs/<id>.jpg``, and updates ``manifest.json`` — a list of:

  {id, file, uploader, caption, channel, ts, w, h, favourite, thumb}

``id`` is a content hash of the *source* image, so reruns never duplicate and
the same photo dropped twice collapses to one entry. The thumbnail filename
reuses that same id, so thumbnail generation is idempotent for free — no
separate hash needed. ``favourite`` defaults to ``false`` for newly published
photos and is flipped only via ``set_favourite()`` (the ``/favourite`` route
in app.py). Both fields are additive: older manifests/entries missing them
are tolerated everywhere they're read, and ``backfill_thumbnails()`` is a
one-shot pass that fills them in for pre-existing entries.

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
MAX_THUMB_EDGE = _env_int("MAX_THUMB_EDGE", 300)  # gallery thumbnail long edge, px
THUMB_QUALITY = _env_int("THUMB_QUALITY", 80)     # gallery thumbnail re-encode quality
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
    thumbs: Path

    @classmethod
    def from_args(cls, args: argparse.Namespace) -> "Config":
        """Resolve paths with precedence: CLI flag > env var > repo-relative default.

        ``INCOMING_DIR`` and ``OUTPUT_DIR`` are the two env vars the add-on
        sets (``OUTPUT_DIR`` is the parent of ``photos/``, ``thumbs/``, and
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

        if args.thumbs:
            thumbs = Path(args.thumbs)
        elif output_env:
            thumbs = Path(output_env) / "thumbs"
        else:
            thumbs = data_default / "thumbs"

        if args.manifest:
            manifest = Path(args.manifest)
        elif output_env:
            manifest = Path(output_env) / "manifest.json"
        else:
            manifest = data_default / "manifest.json"

        return cls(incoming.resolve(), photos.resolve(), manifest.resolve(), thumbs.resolve())


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


def _flatten_to_rgb(img: Image.Image) -> Image.Image:
    """Flatten transparency onto white (JPEG has no alpha) and ensure RGB."""
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        background = Image.new("RGB", img.size, (255, 255, 255))
        background.paste(img, mask=img.split()[-1])
        return background
    if img.mode != "RGB":
        return img.convert("RGB")
    return img


def _decode_normalized(data: bytes) -> Image.Image:
    """Open raw image bytes, honor EXIF orientation, and flatten to RGB.

    Returns a standalone in-memory copy (safe to use after this function
    returns and the source file/BytesIO closes) so callers can derive
    multiple differently-sized outputs from one decode — see
    process_image_and_thumbnail(), which uses this to avoid decoding the
    same upload twice (once per output size).
    """
    with Image.open(io.BytesIO(data)) as img:
        img = ImageOps.exif_transpose(img)  # bake in rotation, then we drop EXIF
        return _flatten_to_rgb(img).copy()


def _resize_to_jpeg(img: Image.Image, max_edge: int, quality: int) -> Tuple[bytes, int, int]:
    """Downscale (never upscale) a normalized image to <=max_edge on its long
    edge and re-encode as JPEG. Operates on a copy — never mutates `img`, so
    the same normalized base can be resized to multiple output sizes."""
    img = img.copy()
    img.thumbnail((max_edge, max_edge), Image.LANCZOS)
    w, h = img.size
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=quality, optimize=True)
    # No exif= passed -> EXIF is not carried into the output.
    return out.getvalue(), w, h


def process_image(data: bytes) -> Tuple[bytes, int, int]:
    """Normalize raw image bytes -> (jpeg_bytes, width, height).

    Honors EXIF orientation, downscales to MAX_LONG_EDGE on the long edge
    (never upscales), flattens to RGB, and re-encodes JPEG with EXIF stripped.
    """
    return _resize_to_jpeg(_decode_normalized(data), MAX_LONG_EDGE, JPEG_QUALITY)


def process_thumbnail(data: bytes) -> bytes:
    """Normalize raw image bytes -> a small gallery-grid thumbnail (JPEG bytes).

    Same EXIF/flatten handling as process_image(), just a much smaller cap
    (MAX_THUMB_EDGE) and lower quality — this is what the frame/ gallery grid
    loads instead of full-size photos, since the display's ancient WebView
    can't comfortably decode dozens of full-res images at once.
    """
    jpeg, _w, _h = _resize_to_jpeg(_decode_normalized(data), MAX_THUMB_EDGE, THUMB_QUALITY)
    return jpeg


def process_image_and_thumbnail(data: bytes) -> Tuple[bytes, int, int, bytes]:
    """Like calling process_image() and process_thumbnail() on the same raw
    bytes, but decodes the source only once instead of twice — used by
    process_one()/run_once(), which always need both outputs from the same
    upload.
    """
    base = _decode_normalized(data)
    jpeg, w, h = _resize_to_jpeg(base, MAX_LONG_EDGE, JPEG_QUALITY)
    thumb_jpeg, _tw, _th = _resize_to_jpeg(base, MAX_THUMB_EDGE, THUMB_QUALITY)
    return jpeg, w, h, thumb_jpeg


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


def _build_entry(eid: str, out_name: str, thumb_name: str, meta: Dict[str, Any], w: int, h: int) -> Dict[str, Any]:
    """Assemble a fresh manifest entry — shared by process_one() and
    run_once() so the entry shape (and its favourite/thumb defaults) is
    defined in exactly one place."""
    return {
        "id": eid,
        "file": out_name,
        "uploader": meta["uploader"],
        "caption": meta["caption"],
        "channel": meta["channel"],
        "ts": meta["ts"],
        "w": w,
        "h": h,
        "favourite": False,
        "thumb": thumb_name,
    }


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
    cfg.thumbs.mkdir(parents=True, exist_ok=True)
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
        jpeg, w, h, thumb_jpeg = process_image_and_thumbnail(src)
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        log.error("corrupt/undecodable %s (%s); quarantining", image.name, exc)
        quarantine(image)
        return None

    out_name = f"{eid}.jpg"
    thumb_name = f"{eid}.jpg"
    atomic_write_bytes(cfg.photos / out_name, jpeg)
    atomic_write_bytes(cfg.thumbs / thumb_name, thumb_jpeg)
    entry = _build_entry(eid, out_name, thumb_name, meta, w, h)
    index[eid] = entry
    remove_source(image)

    new_manifest = sorted(index.values(), key=lambda e: (str(e.get("ts", "")), e["id"]))
    atomic_write_json(cfg.manifest, new_manifest)
    log.info("published %s -> %s (%dx%d, %s)", image.name, out_name, w, h, meta["channel"])
    return entry


def set_favourite(cfg: Config, entry_id: str, value: bool) -> Optional[Dict[str, Any]]:
    """Flip the `favourite` flag on one manifest entry and rewrite the manifest
    atomically (same temp+rename write as everywhere else in this module).

    Returns the updated entry, or ``None`` if no entry with that id exists —
    the caller (app.py's ``POST /favourite``) turns that into a 404.
    """
    manifest = load_manifest(cfg.manifest)
    updated: Optional[Dict[str, Any]] = None
    for entry in manifest:
        if entry.get("id") == entry_id:
            entry["favourite"] = bool(value)
            updated = entry
            break
    if updated is None:
        return None
    atomic_write_json(cfg.manifest, manifest)
    log.info("favourite %s -> %s", entry_id, updated["favourite"])
    return updated


def backfill_thumbnails(cfg: Config) -> int:
    """One-shot backfill for manifest entries published before `thumb`/
    `favourite` existed: generate a thumbnail from the already-processed
    `photos/<file>` (no need to re-read `incoming/` or re-run EXIF/downscale
    normalization — that's already baked into the full-size output) and
    default `favourite` to False. Safe to run repeatedly (skips entries that
    already have a `thumb`); also called once at add-on startup so existing
    photos get thumbnails without a re-upload. Returns the number of entries
    changed.
    """
    cfg.thumbs.mkdir(parents=True, exist_ok=True)
    manifest = load_manifest(cfg.manifest)
    changed = 0
    for entry in manifest:
        if "favourite" not in entry:
            entry["favourite"] = False
            changed += 1
        if entry.get("thumb"):
            continue
        file = entry.get("file")
        photo_path = cfg.photos / file if file else None
        if not photo_path or not photo_path.exists():
            log.warning("backfill: missing photo file for entry %s (%s)", entry.get("id"), file)
            continue
        try:
            thumb_jpeg = process_thumbnail(photo_path.read_bytes())
        except (UnidentifiedImageError, OSError, ValueError) as exc:
            log.error("backfill: could not thumbnail %s: %s", file, exc)
            continue
        thumb_name = f"{entry['id']}.jpg"
        atomic_write_bytes(cfg.thumbs / thumb_name, thumb_jpeg)
        entry["thumb"] = thumb_name
        changed += 1
    if changed:
        atomic_write_json(cfg.manifest, manifest)
        log.info("backfill: updated %d manifest entr%s", changed, "y" if changed == 1 else "ies")
    return changed


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
    cfg.thumbs.mkdir(parents=True, exist_ok=True)
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
            jpeg, w, h, thumb_jpeg = process_image_and_thumbnail(src)
        except (UnidentifiedImageError, OSError, ValueError) as exc:
            log.error("corrupt/undecodable %s (%s); quarantining", image.name, exc)
            quarantine(image)
            continue

        out_name = f"{eid}.jpg"
        thumb_name = f"{eid}.jpg"
        atomic_write_bytes(cfg.photos / out_name, jpeg)
        atomic_write_bytes(cfg.thumbs / thumb_name, thumb_jpeg)
        index[eid] = _build_entry(eid, out_name, thumb_name, meta, w, h)
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
    parser.add_argument("--thumbs", help="override thumbs/ dir")
    parser.add_argument("--manifest", help="override manifest.json path")
    parser.add_argument(
        "--backfill-thumbnails", action="store_true",
        help="generate thumbnails (and default favourite=false) for existing "
             "manifest entries missing them, then exit — does not touch incoming/",
    )
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
    log.info("thumbs  =%s", cfg.thumbs)
    log.info("manifest=%s", cfg.manifest)

    cfg.incoming.mkdir(parents=True, exist_ok=True)
    cfg.photos.mkdir(parents=True, exist_ok=True)
    cfg.thumbs.mkdir(parents=True, exist_ok=True)
    cfg.manifest.parent.mkdir(parents=True, exist_ok=True)

    if args.backfill_thumbnails:
        changed = backfill_thumbnails(cfg)
        log.info("backfill done: %d entr%s updated", changed, "y" if changed == 1 else "ies")
        return 0

    published = run_once(cfg)
    log.info("done: %d new photo%s", published, "" if published == 1 else "s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
