# Provider-neutral production image for apps/api (INFRA-W1D-RAILWAY-G1). The build stage runs the canonical
# scripts/api-runtime.mjs lifecycle unchanged (runbook §22.3); the runtime stage holds only its pruned output.
# Build context is an allowlist (.dockerignore): no .env, tests, migrations or .git ever enter the image.
FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d AS build
WORKDIR /app
COPY . .
RUN node scripts/api-runtime.mjs install \
 && node scripts/api-runtime.mjs build \
 && node scripts/api-runtime.mjs prune

FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d
ENV NODE_ENV=production
WORKDIR /app
# Root-owned, so read-only to the process: the API writes nothing to disk.
COPY --from=build /app /app
USER node
# Exec form: node is PID 1 and receives the platform's SIGTERM directly (src/index.ts handles it).
CMD ["node", "apps/api/dist/index.js"]
