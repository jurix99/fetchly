# ---- Stage 1: build the Next.js (shadcn / Base UI) frontend as a static export ----
FROM node:22-slim AS frontend
WORKDIR /frontend
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

# ffmpeg merges the separate 1080p+ video/audio streams.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

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

EXPOSE 6776

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "6776"]
