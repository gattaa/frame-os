ARG BUILD_FROM
FROM ${BUILD_FROM}

# frame-os pipeline processor — HAOS add-on wrapper.
#
# Canonical (non-HAOS) source: ../../pipeline/ (see ../../pipeline/README.md
# for the full contract this processor implements). src/processor.py here is
# a synced copy (see ../sync.sh) — this Dockerfile only adapts how it's run,
# not what it does.

ARG BUILD_VERSION
ARG BUILD_ARCH
LABEL \
    io.hass.version="${BUILD_VERSION}" \
    io.hass.type="addon" \
    io.hass.arch="${BUILD_ARCH}"

WORKDIR /app

COPY requirements.txt .
# Pillow needs jpeg/zlib/webp at runtime, plus build tools to compile against
# them if no prebuilt musllinux wheel matches this exact Alpine's musl libc.
RUN apk add --no-cache jpeg zlib libwebp \
 && apk add --no-cache --virtual .build-deps gcc musl-dev jpeg-dev zlib-dev libwebp-dev python3-dev \
 && pip3 install --no-cache-dir -r requirements.txt \
 && apk del .build-deps

COPY src/processor.py .
COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
