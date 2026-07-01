ARG BUILD_FROM
FROM ${BUILD_FROM}

# frame-os Telegram bot — HAOS add-on wrapper.
#
# Canonical (non-HAOS) source: ../../telegram/ (see ../../telegram/README.md).
# src/bot.py here is a synced copy (see ../sync.sh) — this Dockerfile only
# adapts how it's run, not the incoming/ drop contract.

ARG BUILD_VERSION
ARG BUILD_ARCH
LABEL \
    io.hass.version="${BUILD_VERSION}" \
    io.hass.type="addon" \
    io.hass.arch="${BUILD_ARCH}"

WORKDIR /app

# No Pillow / image libs here — python-telegram-bot's dependencies (httpx,
# httpcore, certifi, anyio, ...) are pure Python, no build deps needed.
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

COPY src/bot.py .
COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
