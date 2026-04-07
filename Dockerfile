FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime

# TORCH_EXTRA_INDEX: override to install GPU-capable torch, e.g.:
#   docker build --build-arg TORCH_EXTRA_INDEX=https://download.pytorch.org/whl/cu121 ...
ARG TORCH_EXTRA_INDEX=""

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ffmpeg \
    openssh-client \
    poppler-utils \
    python3 \
    python3-pip \
    python3-venv \
  && rm -rf /var/lib/apt/lists/* \
  && python3 -m venv /opt/venv \
  && /opt/venv/bin/pip install --no-cache-dir \
       $([ -n "$TORCH_EXTRA_INDEX" ] && echo "--index-url $TORCH_EXTRA_INDEX torch" || true) \
       openai-whisper

ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app

ENV NODE_ENV=production \
    API_PORT=8790 \
    DATA_DIR=/app/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY server.mjs ./server.mjs
COPY scripts ./scripts
COPY public ./public

RUN mkdir -p /app/data

EXPOSE 8790

CMD ["npm", "run", "start"]