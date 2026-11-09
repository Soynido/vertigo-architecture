# VERTIGO harness — production image.
#
# It runs exactly what the laptop runs today: `node src/index.ts` with Node's native type stripping, no build
# step and no transpiler in the path. A compiled bundle would be a second artifact to keep honest; the served
# revision is already stamped into every `initialize` response, and that stamp must describe THIS source.
FROM node:24-slim

RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
WORKDIR /app

# Dependencies first: they change far less often than the source, so a redeploy of a one-line fix reuses this layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/harness/package.json packages/harness/
RUN pnpm install --frozen-lockfile --filter @vertigo/harness...

COPY packages/harness/ packages/harness/
COPY packages/plugin/ packages/plugin/
# No `COPY config/`: the registries under config/ hold credential hashes and principals. Compose mounts them
# read-only at /app/config, and .dockerignore keeps them (with .run/, *.local* and every env file) out of the
# build context, so no layer of this image carries a secret (PT-IMG-001).

# The revision is baked at build time: it is what the endpoint reports, and a container whose stamp does not
# match its source is exactly the failure this project spent a day proving is invisible from the chat side.
ARG HARNESS_BUILD_REVISION=UNKNOWN
ENV HARNESS_BUILD_REVISION=${HARNESS_BUILD_REVISION} \
    HARNESS_BUILD_DIRTY=false \
    HARNESS_TRANSPORT=http \
    HARNESS_HTTP_HOST=0.0.0.0 \
    HARNESS_HTTP_PORT=8787 \
    NODE_ENV=production

WORKDIR /app/packages/harness
EXPOSE 8787
# No --env-file: the environment comes from compose, so no secret is ever baked into a layer.
CMD ["node", "src/index.ts"]
