FROM node:22-slim AS build

RUN corepack enable && corepack prepare pnpm@10.30.1 --activate

WORKDIR /app

# Copy dependency manifests
COPY package.json pnpm-lock.yaml ./

# Install all dependencies
RUN pnpm install --frozen-lockfile

# Copy source and build
COPY tsconfig.json ./
COPY src/ src/

RUN pnpm build

# --- Production stage ---
FROM node:22-slim

RUN corepack enable && corepack prepare pnpm@10.30.1 --activate

# Create non-root user for runtime
RUN groupadd --gid 1001 mcpuser && \
    useradd --uid 1001 --gid mcpuser --shell /bin/false mcpuser

WORKDIR /app

COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile --prod && chown -R mcpuser:mcpuser /app

# Copy compiled output from build stage
COPY --from=build /app/dist/ dist/

# Drop to non-root
USER mcpuser

EXPOSE 3000

ENV NODE_ENV=production
ENV MCP_PORT=3000
# MCP_SERVER_URL must be set to the external HTTPS URL for OAuth metadata
# e.g., https://ca-servicenow-xxx.azurecontainerapps.io

CMD ["node", "dist/http.js"]
