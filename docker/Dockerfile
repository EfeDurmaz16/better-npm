# docker/Dockerfile — full image with all package manager engines
FROM rust:1.82-alpine AS builder
RUN apk add --no-cache musl-dev openssl-dev openssl-libs-static perl make
WORKDIR /build
COPY crates/ crates/
COPY Cargo.toml Cargo.lock ./
RUN cargo build --release 2>/dev/null || true

FROM node:20-alpine AS runtime
RUN apk add --no-cache git openssh-client python3 go ruby
WORKDIR /app
COPY --from=builder /build/target/release/better-core /usr/local/bin/better-core
COPY package.json ./
COPY src/ src/
RUN npm install --production --ignore-scripts
ENTRYPOINT ["node", "src/index.js"]
CMD ["--help"]
