# The OCI image for a node (V02).
#
# Two stages, so the running image carries the runtime and not the toolchain that installed it.
#
# Node runs the TypeScript directly. This repository deliberately has no build step for its workspace
# packages — they resolve to `src/index.ts` — so there is nothing to compile even if the image tried, and a
# `dist/` inside the image would be a second copy of the source that could disagree with the first.
#
# The default command binds loopback and stops there. Reaching the node from outside the container needs
# `--host 0.0.0.0 --allow-public-bind` and TLS in front of it, and that acknowledgement is the operator's to
# make rather than something an image decides for them: a published port with no acknowledgement is exactly
# the exposure the gateway's own refusal exists to prevent.

FROM node:24-slim AS build
RUN corepack enable
WORKDIR /app
# The whole workspace, because a pnpm lockfile describes every package in it: installing a subset would
# resolve against a lockfile that no longer matches what is present.
COPY . .
# `--frozen-lockfile` is what makes the image reproducible rather than "whatever was newest that day", and it
# is also what catches a dependency added without regenerating the lockfile.
RUN pnpm install --frozen-lockfile
# The web client, so a node reached from a browser serves its own interface (`CC_WEB_DIST`).
RUN pnpm --filter @clarkcant/app-web run build

FROM node:24-slim AS runtime
RUN corepack enable
WORKDIR /app
COPY --from=build /app /app
# Only what the runtime and its workspace packages need at run time. The build stage carried the toolchain,
# the desktop shell's Electron binary and the test runners; none of that belongs in a running node.
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules packs/*/node_modules examples/*/node_modules \
  && pnpm install --frozen-lockfile --prod --filter "@clarkcant/runtime..." \
  && chown -R node:node /app

# The node's data — identity, database, blobs, transcripts — is mounted rather than baked in. An image that
# carried an identity would give every container the same node id, which is the one thing pairing cannot
# recover from.
ENV CLARKCANT_DATA_DIR=/data
ENV CC_WEB_DIST=/app/apps/web/dist
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8765

# Not root: a node runs commands on the user's behalf, and a container escape should not start with uid 0.
USER node

# `/health` is the one unauthenticated route, which is what makes it usable from here.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8765/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

ENTRYPOINT ["node", "apps/runtime/src/main.ts"]
CMD ["--data-dir", "/data"]
