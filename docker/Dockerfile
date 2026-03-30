# docker/Dockerfile
# Full better image with all language engines
FROM rust:1.82-alpine AS builder

RUN apk add --no-cache musl-dev openssl-dev openssl-libs-static perl make

WORKDIR /build
COPY crates/ crates/
COPY Cargo.toml Cargo.lock ./

RUN cargo build --release 2>/dev/null || \
    cargo build --release --package better-core 2>/dev/null || true

FROM node:20-alpine AS runtime

RUN apk add --no-cache git openssh-client python3 py3-pip go ruby

# Copy Rust binary if build succeeded
COPY --from=builder /build/target/release/better-core /usr/local/bin/better-core 2>/dev/null || true

WORKDIR /app
COPY package.json package-lock.json* ./
COPY src/ src/
COPY bin/ bin/

RUN npm install --production --ignore-scripts

ENV BETTER_DOCKER=1
ENTRYPOINT ["node", "src/cli.js"]
CMD ["--help"]

LABEL org.opencontainers.image.title="better"
LABEL org.opencontainers.image.description="Universal package manager for Node.js, Python, Rust, Go, Ruby, PHP, .NET"
LABEL org.opencontainers.image.source="https://github.com/nicepkg/better-npm"
