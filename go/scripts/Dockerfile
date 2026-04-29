# syntax=docker/dockerfile:1
# Two-stage build for the Go SSL VPN proxy.
#
# Build context is expected to be <repo>/go (so the source at /go/src/ is
# accessible as /src/ inside the build context). Use scripts/build.sh from the
# repo root which sets this up correctly.

# ── Build stage ──────────────────────────────────────────────────────────────
FROM golang:1.24-alpine AS builder

WORKDIR /work
COPY src/go.mod src/go.sum* ./
RUN go mod download || true

COPY src/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags='-s -w' \
    -o /out/cyrano ./cmd/cyrano

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM alpine:3.20

RUN adduser -D -H -u 10001 sslvpn

WORKDIR /app
COPY --from=builder /out/cyrano /app/bin/cyrano
COPY assets /app/assets

USER sslvpn
EXPOSE 9080 9443

# Configuration is read from environment variables at startup (see
# config.FromEnv). Pass CYRANO_PORT, CYRANO_HOSTNAME, etc. to the container.
ENTRYPOINT ["/app/bin/cyrano"]
CMD ["--assets", "/app/assets"]
