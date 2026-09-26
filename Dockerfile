# akou in server mode (docs/ux/SERVER.md section 3): the same Bun core the desktop app runs, under
# plain Bun with AKOU_SERVER=1, started by `akou serve`. No ElectroBun, no tray, no capture helper.
#
#   docker build -t geiserx/akou:<version> .
#   docker run -p 127.0.0.1:8476:8476 -v akou-data:/data -v akou-models:/models geiserx/akou:<version>
#
# The container binds 0.0.0.0, which server mode refuses until `server.behind_proxy` is true in
# /data/.config/akou/config.json (SV-P5): the operator states it, the image never does
# (docs/install.md, "The server").
#   docker run --rm -v akou-data:/data -v akou-models:/models geiserx/akou:<version> models pull fast
#
# Built for linux/amd64 and linux/arm64, each on its own runner (release.yml), and tagged with the
# release's version only: there is never a `latest` tag. Both base images are pinned by digest.
# Speech models are never in the image: they live on the /models volume (`akou models pull`).
#
# One Dockerfile, three variants by ACCELERATOR (akou-5an.94, docs/install.md "A GPU"): each carries
# the pinned llama-server build for its backend in /opt/llama, fetched and checked against its
# SHA-256 by akou's own table (src/main/asr/llama-builds.ts), and falls back to the CPU with it.
#   cpu     geiserx/akou:<version>          no GPU
#   vulkan  geiserx/akou:<version>-vulkan   Intel and AMD GPUs through Mesa: --device /dev/dri
#                                           --group-add $(stat -c %g /dev/dri/renderD128)
#   cuda    geiserx/akou:<version>-cuda     NVIDIA, with the CUDA runtime inside: --gpus all and the
#                                           NVIDIA Container Toolkit; the host needs only the driver
#   docker build --build-arg ACCELERATOR=vulkan -t geiserx/akou:<version>-vulkan .

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

# llama-server for the variant's backend, from the release akou pins, by digest. Only the two files
# the fetch reads are copied, so a change elsewhere in src/ does not download it again.
FROM ${BUN_IMAGE} AS llama
ARG ACCELERATOR=cpu
WORKDIR /src
COPY src/main/asr/llama-builds.ts src/main/asr/models.ts src/main/asr/
RUN bun -e 'await (await import("./src/main/asr/llama-builds.ts")).fetchForHost(process.env.ACCELERATOR, "/opt/llama")'

FROM ${BUN_IMAGE}
ARG ACCELERATOR=cpu
# ffmpeg decodes every container a job may send (SV-P6), llama-server needs OpenMP, and the Vulkan
# variant Mesa's drivers (the loader, libvulkan1, already comes with ffmpeg): one apt line.
RUN case "$ACCELERATOR" in vulkan) gpu="mesa-vulkan-drivers libvulkan1" ;; *) gpu="" ;; esac \
  && apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg libgomp1 $gpu \
  && rm -rf /var/lib/apt/lists/*
COPY --from=llama /opt/llama /opt/llama
RUN /opt/llama/llama-server --version
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
# AKOU_ACCELERATORS is what this image can run (asr.accelerator's `auto` picks among these, and
# GET /v1/server reports the choice), AKOU_LLAMA_SERVER the build it runs.
ENV AKOU_HOME=/data \
  AKOU_MODELS_DIR=/models \
  AKOU_SERVER=1 \
  AKOU_HEADLESS=1 \
  AKOU_ACCELERATORS=${ACCELERATOR},cpu \
  AKOU_LLAMA_SERVER=/opt/llama/llama-server \
  NVIDIA_DRIVER_CAPABILITIES=compute,utility
USER bun
VOLUME ["/data", "/models"]
EXPOSE 8476
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:8476/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["akou"]
CMD ["serve"]
