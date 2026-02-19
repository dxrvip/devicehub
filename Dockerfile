# -------- BUILDER --------
FROM node:20.18.0-bullseye-slim AS builder

WORKDIR /app

# 保留Debian官方源（适配VPN访问），仅增加超时和IPv4强制（避免解析问题）
RUN echo 'Acquire::ForceIPv4 "true";' > /etc/apt/apt.conf.d/99force-ipv4

# 安装编译依赖（延长超时到120秒，适配VPN延迟）
RUN apt-get update -o Acquire::Timeout=120 && \
    apt-get install -y --no-install-recommends \
    python3 \
    git \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY . .

# 后端构建步骤
RUN if [ ! -f "./bin/stf.mjs" ]; then echo "ERROR: stf.mjs not found!" && exit 1; fi \
    && sed -i 's%./node_modules/.bin/tsx%node%g' ./bin/stf.mjs \
    && npm config set registry https://registry.npmmirror.com \
    && npm ci --loglevel verbose --timeout 300000 --no-fund \
    && ./node_modules/.bin/tsc -p tsconfig.node.json \
    && npm prune --production

# 前端构建步骤
WORKDIR /app/ui

RUN if [ ! -f "./package.json" ]; then echo "ERROR: ui/package.json not found!" && exit 1; fi \
    && if [ ! -f "./vite.config.js" ] && [ ! -f "./vite.config.ts" ]; then echo "ERROR: vite config not found!" && exit 1; fi \
    && npm config set registry https://registry.npmmirror.com \
    && npm ci --loglevel verbose --timeout 300000 --no-fund \
    && npx tsc -b --verbose \
    && npx vite build --debug \
    && if [ ! -d "./dist" ]; then echo "ERROR: vite build failed, dist folder not found!" && exit 1; fi

# -------- RUNTIME --------
FROM node:20.18.0-bullseye-slim

LABEL org.opencontainers.image.source=https://github.com/VKCOM/devicehub
LABEL org.opencontainers.image.title=DeviceHub
LABEL org.opencontainers.image.vendor=VKCOM
LABEL org.opencontainers.image.description="Control and manage Android and iOS devices from your browser."
LABEL org.opencontainers.image.licenses=Apache-2.0

ENV PATH=/app/bin:$PATH
ENV NODE_OPTIONS="--max-old-space-size=32768"

EXPOSE 3000
WORKDIR /app

# 运行时仅安装curl，同样适配VPN
RUN echo 'Acquire::ForceIPv4 "true";' > /etc/apt/apt.conf.d/99force-ipv4 && \
    apt-get update -o Acquire::Timeout=120 && \
    apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/ui/dist \
    && useradd --system --create-home --shell /usr/sbin/nologin devicehub-user \
    && chown -R devicehub-user:devicehub-user /app

# 拷贝构建产物（确保权限正确）
COPY --from=builder --chown=devicehub-user:devicehub-user /app .
RUN rm -rf ./ui/src ./ui/node_modules \
    && ln -s /app/bin/stf.mjs /app/bin/stf \
    && ln -s /app/bin/stf.mjs /app/bin/devicehub \
    && ln -s /app/bin/stf.mjs /app/bin/dh

USER devicehub-user

CMD ["devicehub", "--help"]