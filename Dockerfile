# Build context: repository root (monorepo with npm workspaces).
# docker buildx build -f servers/zip/Dockerfile .
#
# servers/timezone ships too: mcp-license reads the shared business profile's home zone
# through it. No other server is needed; zip_bundle_month reads the sibling servers'
# output folders as plain directories, not through a package dependency, so nothing
# else has to be installed for it to work.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
COPY packages ./packages
COPY servers ./servers
RUN npm install --no-audit --no-fund \
 && npm run build --workspace @theluckystrike/mcp-timezone \
 && npm run build --workspace @theluckystrike/mcp-license \
 && npm run build --workspace @theluckystrike/mcp-zip

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=build /app/servers/timezone/package.json ./servers/timezone/package.json
COPY --from=build /app/servers/timezone/dist ./servers/timezone/dist
COPY --from=build /app/packages/mcp-license/package.json ./packages/mcp-license/package.json
COPY --from=build /app/packages/mcp-license/dist ./packages/mcp-license/dist
COPY --from=build /app/servers/zip/package.json ./servers/zip/package.json
COPY --from=build /app/servers/zip/dist ./servers/zip/dist
RUN npm install --omit=dev --no-audit --no-fund --workspace @theluckystrike/mcp-zip --include-workspace-root=false
CMD ["node", "servers/zip/dist/index.js"]
