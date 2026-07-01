#!/usr/bin/with-contenv bashio
# frame-os pipeline processor — HAOS add-on entrypoint.
set -e

INCOMING_DIR="/share/frame/incoming"
OUTPUT_DIR="/config/www/frame"

mkdir -p "${INCOMING_DIR}" "${OUTPUT_DIR}/photos"

export INCOMING_DIR OUTPUT_DIR
export POLL_INTERVAL="$(bashio::config 'poll_interval')"
export MAX_LONG_EDGE="$(bashio::config 'max_long_edge')"
export JPEG_QUALITY="$(bashio::config 'jpeg_quality')"

bashio::log.info "frame-pipeline starting"
bashio::log.info "  incoming = ${INCOMING_DIR}  (share, rw)"
bashio::log.info "  output   = ${OUTPUT_DIR}  (config, rw; served at /local/frame/)"
bashio::log.info "  poll_interval=${POLL_INTERVAL}s max_long_edge=${MAX_LONG_EDGE}px jpeg_quality=${JPEG_QUALITY}"

exec python3 /app/processor.py --loop --interval "${POLL_INTERVAL}"
