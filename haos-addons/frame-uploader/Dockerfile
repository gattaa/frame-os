ARG BUILD_FROM
FROM ${BUILD_FROM}

# frame-os uploader sidecar — HAOS add-on wrapper.
#
# Canonical (non-HAOS) source: ../../uploader/ (see ../../uploader/README.md).
# src/app.py here is a synced copy (see ../sync.sh) — this Dockerfile only
# adapts how it's run (ingress, Supervisor-only IP restriction), not what it
# does or the incoming/ drop contract.

ARG BUILD_VERSION
ARG BUILD_ARCH
LABEL \
    io.hass.version="${BUILD_VERSION}" \
    io.hass.type="addon" \
    io.hass.arch="${BUILD_ARCH}"

WORKDIR /app

COPY requirements.txt .
RUN apk add --no-cache jpeg zlib libwebp \
 && apk add --no-cache --virtual .build-deps gcc musl-dev jpeg-dev zlib-dev libwebp-dev python3-dev \
 && pip3 install --no-cache-dir -r requirements.txt \
 && apk del .build-deps

COPY src/app.py .
COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
