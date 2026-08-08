# Stage 1: Build AXL with correct Go version
FROM golang:1.25-bookworm AS builder
WORKDIR /app
RUN git clone https://github.com/gensyn-ai/axl.git axl && \
    cd axl && \
    sed -i -E 's/^go .*/go 1.25.0/' go.mod && \
    CGO_ENABLED=0 go build -o ../axl-bin/node ./cmd/node

# Stage 2: Final Node.js environment
FROM node:18-bookworm-slim
# Install Python 3 stdlib
RUN apt-get update && apt-get install -y python3 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy AXL binary from builder
COPY --from=builder /app/axl-bin/node ./axl-bin/node

# Install node modules
COPY package*.json ./
RUN npm install

# Copy application source and configs
COPY tsconfig.json ./
COPY src/ ./src/
COPY dashboard/ ./dashboard/
COPY private-a.pem private-b.pem .env* ./
COPY node-config-a.json node-config-b.json ./

# Entrypoint
CMD ["npx", "tsx", "src/index.ts"]
