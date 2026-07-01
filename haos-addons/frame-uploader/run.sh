#!/usr/bin/with-contenv bashio
# frame-os uploader sidecar — HAOS add-on entrypoint.
set -e

INCOMING_DIR="/share/frame/incoming"
mkdir -p "${INCOMING_DIR}"

UPLOAD_TOKEN="$(bashio::config 'upload_token')"
if [ -z "${UPLOAD_TOKEN}" ] || [ "${#UPLOAD_TOKEN}" -lt 16 ]; then
    bashio::exit.nok "upload_token must be set to a random string of at least 16 characters (see DOCS.md — e.g. run 'openssl rand -hex 32' and paste the result). Refusing to start with a blank/weak secret."
fi

export INCOMING_DIR
export UPLOAD_TOKEN
export MAX_UPLOAD_MB="$(bashio::config 'max_upload_mb')"
export RATE_LIMIT_PER_MIN="$(bashio::config 'rate_limit_per_min')"
export ALLOWED_ORIGINS="$(bashio::config 'allowed_origins')"
export UPLOADER_HOST="0.0.0.0"
export UPLOADER_PORT="8099"
# This add-on ships with ingress: true and no `ports:` mapping (see
# config.yaml), so the only way in is through the Supervisor's ingress proxy.
# Enforce that at the app layer too, per the documented ingress security
# requirement (only 172.30.32.2 may reach an ingress add-on's container):
# https://developers.home-assistant.io/docs/apps/presentation#ingress
export RESTRICT_TO_SUPERVISOR="true"

bashio::log.info "frame-uploader starting on :${UPLOADER_PORT} (ingress only) — incoming=${INCOMING_DIR}"

exec python3 -m uvicorn app:app --host "${UPLOADER_HOST}" --port "${UPLOADER_PORT}"
