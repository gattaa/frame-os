"""frame-os Telegram ingest bot (standalone — NOT via Home Assistant).

A second writer into the shared `incoming/` directory. It listens to an
allowlisted chat/group, and for each received photo it downloads the
highest-resolution version and drops it — plus a matching `<image>.meta.json`
sidecar — into `incoming/`, exactly like the HA uploader does.

The drop contract is identical to every other channel (see ../CLAUDE.md):
    incoming/<id>.<ext>             the raw image
    incoming/<id>.<ext>.meta.json   {uploader, caption, channel:"telegram", ts}

So the processor and the PWA neither know nor care that Telegram sent it. This
bot is a bootstrap/fallback channel: the quickest way to get real photos
flowing, and a backup if the uploader path is down.
"""

from __future__ import annotations

import json
import logging
import mimetypes
import os
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Set

try:
    from dotenv import load_dotenv
    load_dotenv()  # load telegram/.env if present
except ImportError:
    pass

from telegram import Update
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("telegram-bot")
# httpx logs every API call at INFO; quiet it down.
logging.getLogger("httpx").setLevel(logging.WARNING)

# --- Config -----------------------------------------------------------------

TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
INCOMING_DIR = Path(os.getenv("INCOMING_DIR", "../data/incoming"))
CHANNEL = "telegram"
MAX_CAPTION_LEN = 280


def _parse_allowlist(raw: str) -> Set[int]:
    ids: Set[int] = set()
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            ids.add(int(part))
        except ValueError:
            log.warning("ignoring non-numeric chat id in allowlist: %r", part)
    return ids


ALLOWED_CHAT_IDS = _parse_allowlist(os.getenv("TELEGRAM_ALLOWED_CHAT_IDS", ""))

# --- The drop (identical contract to the uploader) --------------------------

def _atomic_write_bytes(path: Path, data: bytes) -> None:
    tmp = path.with_name(f".{path.name}.tmp.{os.getpid()}")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def drop_photo(data: bytes, ext: str, uploader: str, caption: str) -> str:
    """Write image + sidecar into incoming/. Sidecar is written first, then the
    image is revealed via atomic rename, so the processor never sees an image
    without its meta. Returns the incoming id."""
    INCOMING_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%dT%H%M%S", time.gmtime())
    upload_id = f"{stamp}-{uuid.uuid4().hex[:8]}"
    img_name = f"{upload_id}.{ext}"
    img_path = INCOMING_DIR / img_name
    meta_path = INCOMING_DIR / f"{img_name}.meta.json"

    meta = {
        "uploader": uploader,
        "caption": caption,
        "channel": CHANNEL,
        "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }

    staged = INCOMING_DIR / f".{img_name}.part"
    staged.write_bytes(data)
    _atomic_write_bytes(meta_path, (json.dumps(meta, ensure_ascii=False) + "\n").encode("utf-8"))
    os.replace(staged, img_path)
    return upload_id

# --- Helpers ----------------------------------------------------------------

def _is_allowed(chat_id: int) -> bool:
    return chat_id in ALLOWED_CHAT_IDS


def _sender_name(update: Update) -> str:
    user = update.effective_user
    if user is None:
        return "telegram"
    name = (user.full_name or "").strip() or (user.username or "").strip()
    return (name or str(user.id))[:80]

# --- Handlers ---------------------------------------------------------------

async def cmd_id(update: Update, _ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """Reply with this chat's id — handy for filling TELEGRAM_ALLOWED_CHAT_IDS.
    Intentionally NOT allowlist-gated so you can discover the id during setup."""
    chat = update.effective_chat
    if chat is None or update.message is None:
        return
    allowed = "yes" if _is_allowed(chat.id) else "no (add it to the allowlist)"
    await update.message.reply_text(f"chat id: {chat.id}\nallowed: {allowed}")


async def cmd_start(update: Update, _ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if update.message is None:
        return
    await update.message.reply_text(
        "frame-os bot. Send me a photo (with an optional caption) and I'll add "
        "it to the frame. Use /id to see this chat's id."
    )


async def on_photo(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    message = update.message
    chat = update.effective_chat
    if message is None or chat is None:
        return

    if not _is_allowed(chat.id):
        log.info("ignoring photo from non-allowlisted chat %s", chat.id)
        return

    try:
        file_id, ext = _pick_file(message)
        if file_id is None:
            return
        tg_file = await context.bot.get_file(file_id)
        data = bytes(await tg_file.download_as_bytearray())
        if not data:
            raise ValueError("empty download")

        uploader = _sender_name(update)
        caption = (message.caption or "").strip()[:MAX_CAPTION_LEN]
        upload_id = drop_photo(data, ext, uploader, caption)

        log.info("dropped %s (%d bytes) from %s", upload_id, len(data), uploader)
        await message.reply_text("📷 Added to the frame — thanks!")
    except Exception:
        log.exception("failed to handle photo")
        try:
            await message.reply_text("⚠️ Sorry, that photo didn't go through. Try again?")
        except Exception:
            pass  # never let the reply failure bubble up


def _pick_file(message) -> tuple[Optional[str], str]:
    """Return (file_id, ext) for the best image in the message, or (None, '')."""
    # Compressed photos: a list of sizes ascending; take the largest.
    if message.photo:
        return message.photo[-1].file_id, "jpg"
    # Sent "as file" (uncompressed): only accept image documents.
    doc = message.document
    if doc and (doc.mime_type or "").startswith("image/"):
        ext = ""
        if doc.file_name and "." in doc.file_name:
            ext = doc.file_name.rsplit(".", 1)[-1].lower()
        if not ext:
            guessed = mimetypes.guess_extension(doc.mime_type or "") or ".jpg"
            ext = guessed.lstrip(".")
        if ext == "jpeg":
            ext = "jpg"
        return doc.file_id, ext
    return None, ""


async def on_error(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
    # Network blips and API errors land here; log and carry on. run_polling
    # itself keeps retrying getUpdates, so the bot reconnects automatically.
    log.warning("update error: %s", context.error)

# --- Entry point ------------------------------------------------------------

def main() -> None:
    if not TOKEN or TOKEN == "change-me":
        raise SystemExit("TELEGRAM_BOT_TOKEN is not set (see telegram/.env.example)")
    if not ALLOWED_CHAT_IDS:
        log.warning("TELEGRAM_ALLOWED_CHAT_IDS is empty — the bot will ignore all "
                    "photos. Add chat ids (use /id to find them).")

    log.info("incoming dir: %s", INCOMING_DIR.resolve())
    log.info("allowlisted chats: %s", sorted(ALLOWED_CHAT_IDS) or "(none)")

    app = Application.builder().token(TOKEN).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("id", cmd_id))
    app.add_handler(MessageHandler(filters.PHOTO | filters.Document.IMAGE, on_photo))
    app.add_error_handler(on_error)

    log.info("bot starting (polling)…")
    # run_polling reconnects on network errors with backoff automatically.
    app.run_polling(allowed_updates=Update.ALL_TYPES, drop_pending_updates=True)


if __name__ == "__main__":
    main()
