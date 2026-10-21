# Tempo Explorer

## Getting Started

To run this application (defaults to `testnet` chain):

```bash
pnpm install
pnpm dev
```

To run `devnet` chain:

```sh
pnpm dev:devnet
```

### Styling

This project uses [Tailwind CSS](https://tailwindcss.com) for styling.

### Linting, Formatting & Type Checking

This project uses [Biome](https://biomejs.dev) for linting and formatting.

To format & lint:

```bash
pnpm check
```

To check types:

```bash
pnpm check:types
```

## Adding new features

When adding new features, please read TanStack Router and Start docs first.

[TanStack Router](https://tanstack.com/router/latest/docs)
[TanStack Start](https://tanstack.com/start/latest/docs)

# RPC backend configuration

See [RPC.md](./RPC.md) for the `/api/rpc` endpoint, per-Worker Orchestra secrets,
and rollout verification.

## Request timings

Explorer does not load PostHog in the browser. To capture server request timings,
set `POSTHOG_API_KEY` to a PostHog project ingestion token using a Cloudflare
Worker secret for each environment. Without the secret, timing capture is disabled.
Use a dedicated Explorer project/token; do not reuse a token exposed by browser clients.

The Worker emits `explorer.server.request_duration` for a random 25% of accepted
dynamic requests, with `duration_ms`, normalized `route_pattern`, `method`,
`status_code`, `environment`, and `sample_rate`. Requests rejected by the host,
request, or rate-limit guards, static files, and `/dd-proxy` are excluded.
Delivery runs in `waitUntil` with a three-second timeout. Events contain no
request bodies, query strings, headers, or visitor identifiers.

These timings measure response preparation in the Worker, including awaited
backend calls. They exclude streamed response completion, browser network time,
and rendering. They replace the browser profiling events with a distinct event;
charts and alerts using the old events need updating. Datadog RUM and Sentry
remain separately configured.
