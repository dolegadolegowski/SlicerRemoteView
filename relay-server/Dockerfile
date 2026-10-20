# The relay image (ADR 0007 §5, SRV-20): the relay and the web viewer it serves (ADR 0006).
# Build context = repository root, with its .dockerignore:
#
#   docker build -f relay-server/Dockerfile -t slicerremoteview-relay:local .
#   RELAY_IMAGE=slicerremoteview-relay:local npm test -w relay-server -- docker-smoke
#
# Railway injects PORT, so nothing is EXPOSEd; outside Railway see relay-server/README.md "Docker"
# (TRUST_PROXY=false without an edge proxy in front).

# Stage 1: install every workspace and build shared, the web viewer and the relay.
FROM node:22-alpine AS build
WORKDIR /repo
# Manifests first, so that the dependency layer is reused while only sources change.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY relay-server/package.json relay-server/
COPY web-viewer/package.json web-viewer/
COPY tools/fake-slicer/package.json tools/fake-slicer/
RUN npm ci
COPY . .
RUN npm run build -w shared -w web-viewer -w relay-server --if-present
# The relay's file server follows symbolic links, also out of public/ (SRV-16): the viewer build
# must not contain any.
RUN test -z "$(find web-viewer/dist -type l)" || { echo "symbolic link in web-viewer/dist" >&2; exit 1; }

# Stage 2: production dependencies of the relay only, its build and the viewer build in public/.
FROM node:22-alpine AS runtime
RUN apk add --no-cache dumb-init
WORKDIR /app
# npm ci needs every workspace manifest of the lockfile; -w installs the relay's dependencies only
# (and the workspace links of shared and the relay). No install scripts run in the shipped stage.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY relay-server/package.json relay-server/
COPY web-viewer/package.json web-viewer/
COPY tools/fake-slicer/package.json tools/fake-slicer/
RUN npm ci --omit=dev --ignore-scripts -w relay-server \
    && npm cache clean --force \
    && rm -rf /root/.npm /tmp/node-compile-cache
COPY --from=build /repo/shared/dist shared/dist
COPY --from=build /repo/relay-server/dist relay-server/dist
COPY --from=build /repo/web-viewer/dist relay-server/public
# Node sizes its heap from the container's memory limit (DEP-06 reads heapSizeLimit from the
# relay's `relay starting` line).
ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size-percentage=75
# Everything above belongs to root; the relay runs as `node` (uid 1000) and writes nothing.
USER node
WORKDIR /app/relay-server
# dumb-init is PID 1: it forwards SIGTERM to Node (graceful drain, SRV-17) and reaps zombies.
CMD ["dumb-init", "node", "dist/index.js"]
