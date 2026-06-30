# telegram/ — bootstrap bot (test harness + fallback channel)

A standalone [`python-telegram-bot`](https://python-telegram-bot.org/) script —
**not** routed through Home Assistant. It's a second writer into the shared
`incoming/` directory: it listens to an allowlisted chat/group and drops every
photo it receives, with attribution, for the pipeline processor to pick up.

**Role in the architecture contract:** an ingest channel that writes **only**
into `../data/incoming/`. See [`../CLAUDE.md`](../CLAUDE.md).

## Same contract as the HA uploader

This bot writes the exact same pair every channel writes:

```
incoming/<id>.<ext>             the raw image (highest-res version)
incoming/<id>.<ext>.meta.json   {uploader, caption, channel:"telegram", ts}
```

- `uploader` = the sender's Telegram name
- `caption`  = the photo's caption (if any)
- `channel`  = `"telegram"`

Because the drop is identical, **the processor and the PWA neither know nor care
which channel sent a photo.** That's the whole point: this bot is a
**bootstrap/fallback** channel — the fastest way to get real photos flowing
while the uploader/proxy is being set up, and a backup if that path is down.

## Setup

### 1. Create the bot (BotFather)

1. In Telegram, open a chat with [`@BotFather`](https://t.me/BotFather).
2. Send `/newbot`, choose a name and a username.
3. BotFather replies with a **token** like `123456:ABC-DEF...`. Put it in
   `.env` as `TELEGRAM_BOT_TOKEN`.
4. (For group use) either add the bot to your family group, or in BotFather run
   `/setprivacy` → **Disable**, so the bot can see all photos in the group
   (otherwise it only sees photos in messages that reply to it / mention it).

### 2. Find your chat id(s)

1. Fill in the token, run the bot (below).
2. In the chat/group you want to allow, send `/id`. The bot replies with that
   chat's id (groups are negative, e.g. `-1001234567890`).
3. Put the id(s), comma-separated, in `.env` as `TELEGRAM_ALLOWED_CHAT_IDS`,
   then restart the bot. Photos from any non-allowlisted chat are ignored.

`/id` is intentionally **not** allowlist-gated so you can discover ids during
setup; photo handling **is** gated.

### 3. Configure

Copy `.env.example` → `.env` (gitignored) and fill in:

```ini
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_ALLOWED_CHAT_IDS=-1001234567890,42
INCOMING_DIR=../data/incoming      # the SAME incoming/ the processor watches
```

## Run

```bash
cd telegram
pip install -r requirements.txt
python bot.py
```

The bot loads `.env` automatically (via `python-dotenv`). It logs the resolved
incoming dir and allowlist on startup. Send a photo from an allowlisted chat and
it replies with a small confirmation; the photo appears on the frame after the
processor's next pass.

### Behaviour

- Downloads the **highest-resolution** version of each photo. Photos sent
  "as file" (uncompressed image documents) are accepted too.
- Replies with a confirmation on success, and a polite failure note on error —
  it never crashes on a bad photo or a network blip.
- **Reconnects automatically:** `run_polling` retries `getUpdates` with backoff
  through network interruptions; per-update errors are logged via an error
  handler and the bot keeps running.

## Status

Implemented. Standalone bootstrap/fallback ingest channel; identical drop
contract to `uploader/`.
