#!/usr/bin/with-contenv bashio
# frame-os Telegram bot — HAOS add-on entrypoint.
set -e

INCOMING_DIR="/share/frame/incoming"
mkdir -p "${INCOMING_DIR}"

BOT_TOKEN="$(bashio::config 'bot_token')"
if [ -z "${BOT_TOKEN}" ]; then
    bashio::exit.nok "bot_token is not set. Get one from @BotFather and set it in this add-on's Configuration tab (see DOCS.md)."
fi

export INCOMING_DIR
export TELEGRAM_BOT_TOKEN="${BOT_TOKEN}"
export TELEGRAM_ALLOWED_CHAT_IDS="$(bashio::config 'allowed_chat_ids')"

bashio::log.info "frame-telegram starting — incoming=${INCOMING_DIR}"
if [ -z "${TELEGRAM_ALLOWED_CHAT_IDS}" ]; then
    bashio::log.warning "allowed_chat_ids is empty — the bot will ignore all photos until you add chat ids (use /id in the chat to find them)."
fi

exec python3 /app/bot.py
