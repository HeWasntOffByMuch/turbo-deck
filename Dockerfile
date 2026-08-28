# The authoritative server, as an image (spec 153).
#
# Deliberately not a build: the server runs through `tsx`, exactly as
# `npm run server` does. A `tsc` emit would have to compile the renderer's half
# of the tree too -- `tsconfig.json` is one strict project over `src`, and the
# server imports the shared geometry that the renderer also imports -- so a
# production-only compile step would be a second build configuration whose
# output nothing else in the repo ever runs. CI already typechecks this code;
# what the image needs is to run it.
#
# The cost of that choice, measured rather than assumed: ~40 MB of RSS for the
# loader and about a second of boot. Against a process that idles at 129 MB and
# warms its nav grid for a second anyway, neither is worth a second toolchain.
FROM node:22-slim

WORKDIR /app

# `npm ci` needs both files, and copying them alone keeps the dependency layer
# out of the rebuild whenever only source changed.
COPY package.json package-lock.json ./
# Not `--omit=dev`: tsx is a devDependency and is what runs the server.
RUN npm ci --ignore-scripts

# Only what the server actually reads. The renderer's source, the specs, the
# scripts and .claude/ are all excluded by .dockerignore, but naming the paths
# here as well means a new top-level directory does not silently join the image.
COPY tsconfig.json ./
COPY src/ ./src/
COPY maps/ ./maps/
COPY assets/ ./assets/
COPY schemas/ ./schemas/

# The server binds this and Caddy proxies onto it; nothing publishes it directly.
ENV PORT=8787
EXPOSE 8787

# Exec form, so node is the process that receives SIGTERM directly -- `index.ts`
# installs a handler for it and stops the loop, closes the sockets and exits. A
# shell form would put /bin/sh at PID 1, swallow the signal, and turn every
# `compose down` into a ten-second wait and a kill. (`init: true` in compose.yml
# supplies the reaper on top of this.)
CMD ["node", "--import", "tsx", "src/server/index.ts"]
