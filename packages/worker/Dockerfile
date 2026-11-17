FROM node:22.23.5-bookworm-slim AS build
WORKDIR /build
COPY . .
RUN npm ci --ignore-scripts
RUN npm run build --workspace=@pagebeam/worker

FROM node:22.23.5-bookworm-slim AS production-dependencies
WORKDIR /build
COPY --from=build /build/package.json /build/package-lock.json ./
COPY --from=build /build/packages/worker/package.json ./packages/worker/package.json
COPY --from=build /build/packages/app/package.json ./packages/app/package.json
COPY --from=build /build/packages/core/package.json ./packages/core/package.json
RUN npm ci --omit=dev --ignore-scripts --workspace=@pagebeam/worker --workspace=@pagebeam/app --workspace=@pagebeam/core --include-workspace-root=false

FROM node:22.23.5-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates chromium chromium-sandbox fontconfig \
        fonts-liberation fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production HOME=/tmp XDG_CACHE_HOME=/tmp/.cache
WORKDIR /app
COPY --from=production-dependencies /build/node_modules ./node_modules
COPY --from=production-dependencies /build/packages ./packages
COPY --from=build /build/packages/core/dist ./packages/core/dist
COPY --from=build /build/packages/app/dist ./packages/app/dist
COPY --from=build /build/packages/worker/dist ./packages/worker/dist
RUN chmod 755 packages/worker/dist/bin.js \
    && ln -s /app/packages/worker/dist/bin.js /usr/local/bin/pagebeam-worker
USER node
ENTRYPOINT ["pagebeam-worker"]
