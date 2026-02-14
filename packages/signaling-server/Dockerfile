# Dockerfile for signaling server
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY packages/signaling-server/package.json ./
COPY packages/signaling-server/pnpm-lock.yaml* ./

# Install pnpm and dependencies
RUN npm install -g pnpm
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/signaling-server/src ./src
COPY packages/signaling-server/tsconfig.json ./

# Build
RUN pnpm build

# Set port from environment
ENV PORT=3000
EXPOSE 3000

# Start server
CMD ["node", "dist/server.js"]
