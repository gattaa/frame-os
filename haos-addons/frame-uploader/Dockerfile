ARG BUILD_FROM
FROM ${BUILD_FROM}

# frame-os uploader + processor sidecar — HAOS add-on wrapper.
#
# HAOS is the only place this project runs, so src/app.py and src/processor.py
# here are the single source of truth for this add-on — nothing is synced in
# from elsewhere. This Dockerfile only adapts how the app is run (ingress,
# Supervisor-only IP restriction), not what it does or the incoming/ ->
# photos/ + manifest.json contract (see ../../CLAUDE.md).

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

COPY src/app.py src/processor.py ./
COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
