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

FROM node:24-slim AS runtime
RUN corepack enable
WORKDIR /app
COPY --from=build /app /app

# The node's data — identity, database, blobs, transcripts — is mounted rather than baked in. An image that
# carried an identity would give every container the same node id, which is the one thing pairing cannot
# recover from.
ENV CLARKCANT_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8765

ENTRYPOINT ["node", "apps/runtime/src/main.ts"]
CMD ["--data-dir", "/data"]
