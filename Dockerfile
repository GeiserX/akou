# akou in server mode (docs/ux/SERVER.md section 3): the same Bun core the desktop app runs, under
# plain Bun with AKOU_SERVER=1, started by `akou serve`. No ElectroBun, no tray, no capture helper.
#
#   docker build -t geiserx/akou:<version> .
#   docker run -p 8476:8476 -v akou-data:/data -v akou-models:/models geiserx/akou:<version>
#   docker run --rm -v akou-models:/models geiserx/akou:<version> models pull fast
#
# Built for linux/amd64 and linux/arm64, each on its own runner (release.yml), and tagged with the
# release's version only: there is never a `latest` tag. Both base images are pinned by digest.
# Speech models are never in the image: they live on the /models volume (`akou models pull`).

ARG BUN_IMAGE=oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61
ARG RUST_IMAGE=rust:1.97.1-slim-trixie@sha256:8e8cf8f7fd54a2d23d5a743b3a03f56e26b6c774276c33fa0595111704ebb15c

# akou-diarize, for jobs that ask for speakers: built on the same Debian as the runtime image.
FROM ${RUST_IMAGE} AS diarize
RUN apt-get update \
  && apt-get install -y --no-install-recommends g++ pkg-config libssl-dev ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY native/akou-diarize/ ./
RUN cargo build --locked --release && ./target/release/akou-diarize --version

FROM ${BUN_IMAGE}
# ffmpeg decodes every container a job may send (SV-P6): one apt line.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production
COPY src/ src/
COPY skills/ skills/
COPY LICENSE NOTICE README.md ./
COPY --from=diarize /src/target/release/akou-diarize /usr/local/bin/akou-diarize
# `akou` on PATH is the CLI from source; exec makes Bun pid 1, so SIGTERM reaches `akou serve`.
RUN printf '#!/bin/sh\nexec bun /app/src/main/cli/cli.ts "$@"\n' > /usr/local/bin/akou \
  && chmod 0755 /usr/local/bin/akou \
  && mkdir -p /data /models \
  && chown bun:bun /data /models
ENV AKOU_HOME=/data \
  AKOU_MODELS_DIR=/models \
  AKOU_SERVER=1 \
  AKOU_HEADLESS=1
USER bun
VOLUME ["/data", "/models"]
EXPOSE 8476
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:8476/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["akou"]
CMD ["serve"]
