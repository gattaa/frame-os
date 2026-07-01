"""frame-os uploader sidecar.

An ingest channel: it accepts image uploads (from the custom Lovelace card in
the Home Assistant app) and drops them — plus a matching `<image>.meta.json`
sidecar — into the shared `incoming/` directory the pipeline processor watches.

It knows NOTHING about photo processing or the manifest. Per the architecture
contract (see ../CLAUDE.md) it only ever writes into `incoming/`. The processor
is the sole writer of `photos/` + `manifest.json`.

Contract for the drop:
    incoming/<id>.<ext>             the raw image (validated, original bytes)
    incoming/<id>.<ext>.meta.json   {uploader, caption, channel:"ha", ts}
"""

from __future__ import annotations

import io
import json
import os
import time
import uuid
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Deque, Dict, Optional

from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from PIL import Image, UnidentifiedImageError

# --- Config (env-driven) ----------------------------------------------------

INCOMING_DIR = Path(os.getenv("INCOMING_DIR", "/data/incoming"))
MAX_UPLOAD_MB = float(os.getenv("MAX_UPLOAD_MB", "25"))
MAX_UPLOAD_BYTES = int(MAX_UPLOAD_MB * 1024 * 1024)
# Comma-separated list of allowed origins for CORS, e.g. "https://ha.example.com".
ALLOWED_ORIGINS = [
    o.strip() for o in os.getenv("ALLOWED_ORIGINS", "*").split(",") if o.strip()
]
# Optional shared secret. If set, the card must send it as X-Upload-Token.
UPLOAD_TOKEN = os.getenv("UPLOAD_TOKEN", "")
# Simple in-process rate limit: max uploads per client per rolling 60s window.
RATE_LIMIT_PER_MIN = int(os.getenv("RATE_LIMIT_PER_MIN", "12"))
# When true, reject any request not from the Home Assistant Supervisor's
# ingress proxy (172.30.32.2 is its fixed internal address; see
# https://developers.home-assistant.io/docs/apps/presentation#ingress).
# Set by the HAOS add-on's run.sh when ingress is the configured transport;
# leave false for the plain docker-compose / direct-port deployment.
RESTRICT_TO_SUPERVISOR = os.getenv("RESTRICT_TO_SUPERVISOR", "").strip().lower() in ("1", "true", "yes")
SUPERVISOR_PROXY_IP = "172.30.32.2"
CHANNEL = "ha"
MAX_CAPTION_LEN = 280

# Pillow format -> file extension. Only these are accepted as "an image".
FORMAT_EXT = {
    "JPEG": "jpg",
    "MPO": "jpg",   # multi-picture JPEG (common from phones)
    "PNG": "png",
    "GIF": "gif",
    "WEBP": "webp",
    "BMP": "bmp",
    "TIFF": "tiff",
}

app = FastAPI(title="frame-os uploader", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
    allow_credentials=False,
)


@app.middleware("http")
async def _restrict_to_supervisor(request: Request, call_next):
    """When RESTRICT_TO_SUPERVISOR is set, only the Supervisor's ingress proxy
    may reach this app directly (defense in depth on top of ingress itself —
    see the HA docs note linked above RESTRICT_TO_SUPERVISOR)."""
    if RESTRICT_TO_SUPERVISOR:
        client = request.client.host if request.client else None
        if client != SUPERVISOR_PROXY_IP:
            return JSONResponse(status_code=403, content={"detail": "forbidden"})
    return await call_next(request)


# Rolling per-client rate limit: a deque of recent request timestamps per key.
_rate_state: Dict[str, Deque[float]] = defaultdict(deque)


def _client_key(request: Request) -> str:
    # Behind ingress/a reverse proxy the socket peer is the proxy itself;
    # X-Forwarded-For carries the real client when the proxy sets it.
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _rate_limited(key: str) -> bool:
    now = time.monotonic()
    dq = _rate_state[key]
    while dq and now - dq[0] > 60.0:
        dq.popleft()
    if len(dq) >= RATE_LIMIT_PER_MIN:
        return True
    dq.append(now)
    return False


@app.on_event("startup")
def _ensure_incoming() -> None:
    INCOMING_DIR.mkdir(parents=True, exist_ok=True)


# --- Helpers ----------------------------------------------------------------

def _new_id() -> str:
    """Sortable, collision-resistant id for the incoming file (a receipt id)."""
    stamp = time.strftime("%Y%m%dT%H%M%S", time.gmtime())
    return f"{stamp}-{uuid.uuid4().hex[:8]}"


def _sniff_image(data: bytes) -> str:
    """Validate bytes are a supported, fully-decodable image; return the ext.

    We fully decode (load) rather than just verify() the header: a truncated
    upload can pass verify() but fail full decode, and the processor would then
    quarantine it AFTER we already returned a success receipt. Decoding here
    means a bad upload is rejected up front with a 4xx the user can act on.
    """
    try:
        with Image.open(io.BytesIO(data)) as im:
            fmt = im.format or ""
            im.load()  # force full decode; raises on truncation/corruption
    except (UnidentifiedImageError, OSError, ValueError):
        raise HTTPException(status_code=400, detail="file is not a valid or complete image")
    ext = FORMAT_EXT.get(fmt)
    if not ext:
        raise HTTPException(status_code=400, detail=f"unsupported image format: {fmt}")
    return ext


def _atomic_write_bytes(path: Path, data: bytes) -> None:
    tmp = path.with_name(f".{path.name}.tmp.{os.getpid()}")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def _drop_into_incoming(data: bytes, ext: str, uploader: str, caption: str) -> str:
    """Write the image + its sidecar so the processor never sees one without
    the other: the sidecar is written first, then the image is revealed via an
    atomic rename from a non-scanned `.part` name."""
    upload_id = _new_id()
    img_name = f"{upload_id}.{ext}"
    img_path = INCOMING_DIR / img_name
    meta_path = INCOMING_DIR / f"{img_name}.meta.json"

    meta = {
        "uploader": uploader,
        "caption": caption,
        "channel": CHANNEL,
        "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }

    # 1. Stage the image under a hidden, non-scanned name.
    staged = INCOMING_DIR / f".{img_name}.part"
    staged.write_bytes(data)
    # 2. Write the sidecar fully (atomic).
    _atomic_write_bytes(meta_path, (json.dumps(meta, ensure_ascii=False) + "\n").encode("utf-8"))
    # 3. Reveal the image (now its sidecar already exists).
    os.replace(staged, img_path)
    return upload_id


# --- Routes -----------------------------------------------------------------

@app.get("/health")
def health() -> dict:
    return {"status": "ok", "incoming": str(INCOMING_DIR), "channel": CHANNEL}


@app.post("/upload")
async def upload(
    request: Request,
    file: UploadFile = File(...),
    uploader: str = Form("family"),
    caption: str = Form(""),
    x_upload_token: Optional[str] = Header(default=None),
) -> JSONResponse:
    if UPLOAD_TOKEN and x_upload_token != UPLOAD_TOKEN:
        raise HTTPException(status_code=401, detail="invalid or missing upload token")

    if _rate_limited(_client_key(request)):
        raise HTTPException(status_code=429, detail="too many uploads, slow down")

    # Stream-read with a hard size cap (don't trust Content-Length alone).
    buf = bytearray()
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        buf.extend(chunk)
        if len(buf) > MAX_UPLOAD_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"file exceeds {MAX_UPLOAD_MB:g} MB limit",
            )
    data = bytes(buf)
    if not data:
        raise HTTPException(status_code=400, detail="empty upload")

    ext = _sniff_image(data)

    uploader = (uploader or "family").strip()[:80] or "family"
    caption = (caption or "").strip()[:MAX_CAPTION_LEN]

    upload_id = _drop_into_incoming(data, ext, uploader, caption)
    return JSONResponse(
        status_code=200,
        content={"id": upload_id, "channel": CHANNEL, "status": "queued"},
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.getenv("UPLOADER_HOST", "0.0.0.0"),
        port=int(os.getenv("UPLOADER_PORT", "8077")),
    )
