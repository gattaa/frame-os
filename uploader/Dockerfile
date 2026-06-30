# frame-os uploader sidecar.
FROM python:3.12-slim

# Pillow runtime libs (slim image ships without them).
RUN apt-get update \
    && apt-get install -y --no-install-recommends libjpeg62-turbo zlib1g \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

# The shared incoming/ dir is mounted here (see docker-compose.yml).
ENV INCOMING_DIR=/data/incoming \
    UPLOADER_HOST=0.0.0.0 \
    UPLOADER_PORT=8077

# Run as a non-root user; it must be able to write the mounted volume.
RUN useradd -u 10001 -m app && mkdir -p /data/incoming && chown -R app /data
USER app

EXPOSE 8077

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0) if urllib.request.urlopen('http://127.0.0.1:8077/health').status==200 else sys.exit(1)"

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8077"]
