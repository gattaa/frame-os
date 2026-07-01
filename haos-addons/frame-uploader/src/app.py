"""frame-os uploader + processor sidecar.

The single HAOS add-on for ingest: it serves its own small upload page
(GET /) and accepts image uploads (POST /upload) — typically opened as a Home
Assistant Ingress sidebar panel. On each upload it saves the raw file plus a
matching `<image>.meta.json` sidecar into `incoming/`, then immediately
processes that one file inline (resize/EXIF/manifest — see `processor.py`)
before responding. It is the only writer of both `incoming/` and
`photos/`/`manifest.json`. See ../CLAUDE.md for the architecture contract and
DOCS.md for why processing is inline rather than a separate polling service.

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
from fastapi.responses import HTMLResponse, JSONResponse
from PIL import Image, UnidentifiedImageError

import processor as proc

# --- Config (env-driven) ----------------------------------------------------

INCOMING_DIR = Path(os.getenv("INCOMING_DIR", "/data/incoming"))
OUTPUT_DIR = Path(os.getenv("OUTPUT_DIR", "/data"))
PROC_CFG = proc.Config(
    incoming=INCOMING_DIR,
    photos=OUTPUT_DIR / "photos",
    manifest=OUTPUT_DIR / "manifest.json",
)
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
    see the HA docs note linked above RESTRICT_TO_SUPERVISOR).

    Reaching this point with RESTRICT_TO_SUPERVISOR set means the request has
    already been proven to come from the Supervisor's ingress proxy, which
    itself only proxies for an already-logged-in HA user — i.e. the request is
    ingress-authenticated. Flag that on request.state so the /upload route can
    skip the redundant upload_token check for this path (see DOCS.md).
    """
    request.state.ingress_verified = False
    if RESTRICT_TO_SUPERVISOR:
        client = request.client.host if request.client else None
        if client != SUPERVISOR_PROXY_IP:
            return JSONResponse(status_code=403, content={"detail": "forbidden"})
        request.state.ingress_verified = True
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
def _ensure_dirs() -> None:
    INCOMING_DIR.mkdir(parents=True, exist_ok=True)
    PROC_CFG.photos.mkdir(parents=True, exist_ok=True)
    PROC_CFG.manifest.parent.mkdir(parents=True, exist_ok=True)


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


def _drop_into_incoming(data: bytes, ext: str, uploader: str, caption: str) -> Path:
    """Write the image + its sidecar so processing never sees one without the
    other: the sidecar is written first, then the image is revealed via an
    atomic rename from a non-scanned `.part` name. Returns the image path."""
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
    return img_path


# --- Upload page (served at GET /, e.g. as an HA Ingress sidebar panel) -----
#
# Self-contained: no external assets, no CDNs (see ../CLAUDE.md, "offline-first
# and fully self-hosted"). Posts multipart to a *relative* "upload" path so it
# keeps working unmodified whether it's reached via HA Ingress (which serves
# it under a per-add-on path prefix) or the mapped-port fallback. This page
# itself isn't bound by the frame/ Chrome-60 constraint — it's opened in a
# phone's/HA companion app's modern WebView, not the kiosk display — so it can
# use fetch(), FormData, etc. freely.
UPLOAD_PAGE_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>Add a photo</title>
<style>
  :root {
    --bar-bg: #f8f9fb;
    --fg: #1b1e27;
    --sub: #5b6170;
    --line: rgba(0, 0, 0, 0.1);
    --accent: #2f6fed;
    --btn-bg: rgba(0, 0, 0, 0.05);
    --ok: #1e8e3e;
    --err: #c5221f;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; min-height: 100%;
    background: var(--bar-bg);
    color: var(--fg);
    font-family: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  }
  .wrap { max-width: 480px; margin: 0 auto; padding: 24px 20px 40px; }
  h1 { font-size: 1.25em; margin: 0 0 4px; }
  p.sub { color: var(--sub); margin: 0 0 24px; font-size: 0.92em; }
  label { display: block; font-size: 0.85em; color: var(--sub); margin: 16px 0 6px; }
  input[type="text"] {
    width: 100%; padding: 12px; border-radius: 10px; border: 1px solid var(--line);
    background: #fff; color: var(--fg); font-size: 1em;
  }
  .file-input {
    display: flex; align-items: center; gap: 10px;
    width: 100%; padding: 12px; border-radius: 10px; border: 1px dashed var(--line);
    background: #fff; cursor: pointer;
  }
  .file-input input[type="file"] { flex: 1; font-size: 0.9em; }
  #preview {
    display: none; max-width: 100%; max-height: 240px; border-radius: 10px;
    margin-top: 14px; object-fit: contain;
  }
  button {
    width: 100%; margin-top: 22px; padding: 14px; border: none; border-radius: 10px;
    background: var(--accent); color: #fff; font-size: 1em; font-weight: 600;
    cursor: pointer;
  }
  button:disabled { opacity: 0.6; cursor: default; }
  .bar {
    display: none; height: 6px; border-radius: 3px; background: var(--btn-bg);
    margin-top: 16px; overflow: hidden;
  }
  .bar-fill { height: 100%; width: 0%; background: var(--accent); transition: width 0.15s; }
  .status { margin-top: 14px; font-size: 0.92em; min-height: 1.2em; }
  .status.ok { color: var(--ok); }
  .status.err { color: var(--err); }
</style>
</head>
<body>
<div class="wrap">
  <h1>Add a photo</h1>
  <p class="sub">Sends straight to the frame — it'll show up in the slideshow shortly.</p>

  <label for="who">Your name</label>
  <input id="who" type="text" placeholder="e.g. Franz" maxlength="80" autocomplete="name">

  <label for="file">Photo</label>
  <div class="file-input">
    <input id="file" type="file" accept="image/*">
  </div>
  <img id="preview" alt="">

  <label for="caption">Caption (optional)</label>
  <input id="caption" type="text" placeholder="Say something about it" maxlength="280">

  <button id="submit" type="button">Send to frame</button>
  <div class="bar" id="bar"><div class="bar-fill" id="barFill"></div></div>
  <div class="status" id="status" role="status" aria-live="polite"></div>
</div>
<script>
(function () {
  var fileInput = document.getElementById("file");
  var preview = document.getElementById("preview");
  var whoInput = document.getElementById("who");
  var captionInput = document.getElementById("caption");
  var submitBtn = document.getElementById("submit");
  var bar = document.getElementById("bar");
  var barFill = document.getElementById("barFill");
  var status = document.getElementById("status");

  try {
    var savedName = localStorage.getItem("frame-os-uploader-name");
    if (savedName) whoInput.value = savedName;
  } catch (e) { /* localStorage unavailable, ignore */ }

  fileInput.addEventListener("change", function () {
    var f = fileInput.files && fileInput.files[0];
    setStatus("");
    if (!f) {
      preview.style.display = "none";
      return;
    }
    var url = URL.createObjectURL(f);
    preview.src = url;
    preview.style.display = "block";
    preview.onload = function () { URL.revokeObjectURL(url); };
  });

  function setStatus(msg, kind) {
    status.textContent = msg || "";
    status.className = "status" + (kind ? " " + kind : "");
  }

  function setBusy(busy) {
    submitBtn.disabled = busy;
    bar.style.display = busy ? "block" : "none";
    if (!busy) barFill.style.width = "0%";
  }

  submitBtn.addEventListener("click", function () {
    var f = fileInput.files && fileInput.files[0];
    if (!f) {
      setStatus("Pick a photo first.", "err");
      return;
    }

    var who = (whoInput.value || "").trim() || "family";
    try { localStorage.setItem("frame-os-uploader-name", who); } catch (e) { /* ignore */ }

    var form = new FormData();
    form.append("file", f, f.name);
    form.append("uploader", who);
    form.append("caption", captionInput.value || "");

    // Relative path: resolves under whatever prefix this page was served
    // from (HA Ingress serves each add-on under its own path prefix), so no
    // hardcoded host and no CORS — same origin, same directory as this page.
    var xhr = new XMLHttpRequest();
    xhr.open("POST", "upload", true);

    xhr.upload.onprogress = function (e) {
      if (e.lengthComputable) {
        var pct = Math.round((e.loaded / e.total) * 100);
        barFill.style.width = pct + "%";
      }
    };
    xhr.onload = function () {
      setBusy(false);
      if (xhr.status >= 200 && xhr.status < 300) {
        var id = "";
        try { id = (JSON.parse(xhr.responseText) || {}).id || ""; } catch (e) { /* ignore */ }
        setStatus("Sent! It will appear on the frame shortly." + (id ? " (#" + id + ")" : ""), "ok");
        fileInput.value = "";
        captionInput.value = "";
        preview.style.display = "none";
      } else {
        var detail = "";
        try { detail = (JSON.parse(xhr.responseText) || {}).detail || ""; } catch (e) { /* ignore */ }
        setStatus("Upload failed (" + xhr.status + ")" + (detail ? ": " + detail : ""), "err");
      }
    };
    xhr.onerror = function () {
      setBusy(false);
      setStatus("Network error — could not reach the frame uploader.", "err");
    };

    setBusy(true);
    setStatus("Uploading…");
    xhr.send(form);
  });
})();
</script>
</body>
</html>
"""


# --- Routes -----------------------------------------------------------------

@app.get("/health")
def health() -> dict:
    return {"status": "ok", "incoming": str(INCOMING_DIR), "channel": CHANNEL}


@app.get("/", response_class=HTMLResponse)
def upload_page() -> HTMLResponse:
    return HTMLResponse(UPLOAD_PAGE_HTML)


@app.post("/upload")
async def upload(
    request: Request,
    file: UploadFile = File(...),
    uploader: str = Form("family"),
    caption: str = Form(""),
    x_upload_token: Optional[str] = Header(default=None),
) -> JSONResponse:
    # Ingress-verified requests are already authenticated by the Supervisor
    # (which only proxies for a logged-in HA user) and same-origin per the
    # ingress iframe, so the upload page's JS never sends X-Upload-Token. The
    # token is enforced only for the non-ingress / mapped-port fallback path,
    # where it's the sole protection. See DOCS.md "Security model" for why
    # this split is safe.
    if UPLOAD_TOKEN and not request.state.ingress_verified and x_upload_token != UPLOAD_TOKEN:
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

    img_path = _drop_into_incoming(data, ext, uploader, caption)

    # Process inline (resize/EXIF/manifest — see processor.py) so the response
    # only comes back once the photo is actually live. See DOCS.md "Inline
    # processing" for why this add-on doesn't return early with a separate
    # poll endpoint: a single small image processes in well under a second.
    entry = proc.process_one(PROC_CFG, img_path)
    if entry is None:
        raise HTTPException(status_code=500, detail="upload saved but processing failed")

    return JSONResponse(
        status_code=200,
        content={
            "id": entry["id"],
            "channel": entry["channel"],
            "status": "ok",
            "w": entry["w"],
            "h": entry["h"],
        },
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.getenv("UPLOADER_HOST", "0.0.0.0"),
        port=int(os.getenv("UPLOADER_PORT", "8077")),
    )
