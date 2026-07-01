# frame-os Telegram Bot

Wraps `telegram/bot.py` (see [`../../telegram/README.md`](../../telegram/README.md))
as a Home Assistant OS add-on. This is a **bootstrap/fallback ingest channel**
— identical drop contract to `frame-uploader`, so the pipeline processor and
the display PWA don't care which one sent a photo. See
[`../../CLAUDE.md`](../../CLAUDE.md) for the architecture contract.

## What it does

Polls Telegram (long-polling, no inbound port needed) for photos sent to an
allowlisted chat/group, downloads the highest-resolution version, and drops it
+ a `{uploader, caption, channel:"telegram", ts}` sidecar into
`/share/frame/incoming`.

## Options

| Option | Type | Default | Description |
|--------|------|---------|--------------|
| `bot_token` | password (**required**) | *(blank — you must set it)* | Token from [@BotFather](https://t.me/BotFather). The add-on refuses to start without one. |
| `allowed_chat_ids` | str | `""` | Comma-separated chat IDs allowed to send photos (groups are negative numbers). Leave blank initially — the bot still starts and logs a warning; use it to discover IDs (see below), then fill this in and restart. |

## Getting a token and finding chat IDs

1. In Telegram, message [`@BotFather`](https://t.me/BotFather) → `/newbot` →
   follow the prompts → copy the token into this add-on's `bot_token` option.
2. For group use: either add the bot to your family group, or run
   `/setprivacy` → **Disable** in BotFather so it can see all photos in the
   group (not just ones that reply to/mention it).
3. Start the add-on with `allowed_chat_ids` left blank.
4. In the target chat, send `/id` — the bot replies with that chat's numeric
   ID (this command is intentionally not allowlist-gated, so it works before
   you've configured anything).
5. Put the ID(s), comma-separated, into `allowed_chat_ids` and restart the
   add-on.

## Shared path (this add-on's `map:`)

| Container path | HA volume | Mode | Purpose |
|---|---|---|---|
| `/share/frame/incoming` | `share` | rw | Drops received photos + sidecars here. |

Created automatically on startup if missing.

## Install / reload as a local add-on

1. Copy this whole `frame-telegram/` folder into your HAOS local add-ons
   location (see [`../README.md`](../README.md) for the `/addons/` path note).
2. Settings → Add-ons → Add-on Store → ⋮ → **Check for updates** (or
   **Reload**). "frame-os Telegram Bot" appears under **Local add-ons**.
3. Install it, set `bot_token` in the Configuration tab, **Start**.
4. Check the **Log** tab for `frame-telegram starting`.

## Iterating on the code

`src/bot.py` is a **synced copy** of the canonical `telegram/bot.py` (see
[`../sync.sh`](../sync.sh)).

```bash
./haos-addons/sync.sh   # re-copies telegram/bot.py in
```

Then bump `version` in `config.yaml` and **Check for updates** → **Update** in
the Add-on Store (Supervisor only rebuilds on a version bump).
