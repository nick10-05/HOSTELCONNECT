# One image for Render: Express serves the API and the built React app.
# Three stages: build the client, build the server, then copy only what runs into a
# small final image. Compilers, dev dependencies and source never reach production.

# Same major version as .nvmrc and CI.
FROM node:24-alpine AS client
WORKDIR /app/client
# package files first: Docker reuses the cached `npm ci` layer until they change.
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

FROM node:24-alpine AS server
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=server /app/server/dist ./dist
# The server finds the client at ../../client/dist from dist/index.js (src/index.ts).
COPY --from=client /app/client/dist /app/client/dist
# The files stay owned by root, and the app runs as the unprivileged "node" user, so
# a bug in the app cannot rewrite its own code.
USER node
# Render sets PORT; 3000 is the default in src/config.ts.
EXPOSE 3000
CMD ["node", "dist/index.js"]
