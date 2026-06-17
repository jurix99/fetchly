# ---- Stage 1: build the Next.js (shadcn / Base UI) frontend as a static export ----
FROM node:22-slim AS frontend
WORKDIR /frontend
# Optionally trust extra CA certs (e.g. a corporate TLS-intercepting proxy) so
# npm/pnpm can reach the registry. Drop *.crt into ./certs on the build host;
# this is a no-op (clean image) when none are present. See certs/README.md.
COPY certs/ /tmp/extra-ca/
RUN mkdir -p /usr/local/share/ca-certificates \
    && (cp /tmp/extra-ca/*.crt /usr/local/share/ca-certificates/ 2>/dev/null || true) \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/* /tmp/extra-ca
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
RUN npm install -g pnpm@9
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN pnpm install --no-frozen-lockfile
COPY frontend/ ./
RUN pnpm build

# ---- Stage 2: the Python app ----
FROM python:3.12-slim

# Deno is yt-dlp's recommended JS runtime for solving YouTube's "n challenge" /
# EJS signature checks. Without a working JS runtime YouTube returns only
# storyboards and every download fails. yt-dlp auto-detects /usr/local/bin/deno.
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno

# Optionally trust extra CA certs (corporate TLS proxy) so pip can reach PyPI.
# No-op / clean image when ./certs has no *.crt. See certs/README.md.
COPY certs/ /tmp/extra-ca/

# ffmpeg merges the separate 1080p+ video/audio streams. gosu drops privileges
# to the NAS user at runtime; tzdata provides zoneinfo for the TZ env var;
# passwd provides usermod/groupmod used by the entrypoint.
RUN mkdir -p /usr/local/share/ca-certificates \
    && (cp /tmp/extra-ca/*.crt /usr/local/share/ca-certificates/ 2>/dev/null || true) \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg ca-certificates gosu tzdata passwd \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/* /tmp/extra-ca

# Point pip (and requests-based tools) at the system bundle, which now includes
# any extra CA copied above.
ENV PIP_CERT=/etc/ssl/certs/ca-certificates.crt \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt

# Unprivileged user the app runs as; the entrypoint remaps it to PUID/PGID.
RUN groupadd -g 911 abc \
    && useradd -u 911 -g abc -d /config -s /usr/sbin/nologin abc

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Install the latest yt-dlp nightly. YouTube changes frequently and breaks
# older releases; rebuild this image periodically to pick up new fixes.
# bgutil-ytdlp-pot-provider is the plugin that fetches PO tokens from the
# bgutil sidecar container (YouTube now gates many videos behind them).
RUN pip install --no-cache-dir -U --pre "yt-dlp[default]" bgutil-ytdlp-pot-provider

COPY app ./app
# Drop the static export where FastAPI serves it (app/web).
COPY --from=frontend /frontend/out ./app/web

# Downloads land here; /config holds settings, the watch list and the download
# archive. Mount host volumes to both paths.
RUN mkdir -p /downloads /config
VOLUME ["/downloads", "/config"]

# NAS-friendly defaults; override per-deployment (see docker-compose.yml).
ENV PUID=1000 \
    PGID=1000 \
    UMASK=022 \
    TZ=Etc/UTC \
    DOWNLOAD_DIR=/downloads \
    CONFIG_DIR=/config

# Runtime entrypoint remaps the user to PUID/PGID and drops privileges via gosu.
# strip CR in case the script was checked out with Windows line endings.
COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

EXPOSE 6776

ENTRYPOINT ["/entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "6776"]
