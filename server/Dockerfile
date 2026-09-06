# Build stage — compiles the ntex signalling server (single crate, no workspace).
FROM rust:1.89-slim AS builder

WORKDIR /app
RUN apt-get update && apt-get install -y pkg-config && rm -rf /var/lib/apt/lists/*

# Prime the dependency cache with a dummy source so changing application code
# doesn't re-download/rebuild every crate.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src \
    && echo "fn main() {}" > src/main.rs \
    && cargo build --release \
    && rm -rf src

# Real source. COPY can leave mtimes older than the cached dummy artifact, so
# bump them to force a real rebuild (deps stay cached).
COPY src src
RUN find src -name '*.rs' -exec touch {} + \
    && cargo build --release
# Guard: fail if the cached stub binary was shipped instead of the real server.
RUN grep -q 'apiplant-send signalling server' target/release/apiplant-send \
    || { echo 'ERROR: built binary is a stub, not the real server'; exit 1; }

# Runtime stage — just the binary + TLS roots.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN useradd -r -s /bin/false appuser

WORKDIR /app
COPY --from=builder /app/target/release/apiplant-send ./apiplant-send

USER appuser
EXPOSE 8080
ENV APIPLANT_SEND_ADDR=0.0.0.0:8080
# Signalling only — the app is served from its own origin (send.apiplant.com).
ENV APIPLANT_SEND_STATIC=/nonexistent
CMD ["./apiplant-send"]
