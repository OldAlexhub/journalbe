# Innerfolio server

This deployable Node.js service is the only public backend for Innerfolio. It accepts strict JSON text contracts only, stores no journal text or extraction results in PostgreSQL, and communicates with one private persistent Python process over line-delimited JSON on stdin/stdout. There are no audio routes, upload middleware, speech packages, generative models, consumer accounts, paid tiers, or subscription endpoints.

## Windows setup

1. Install Node.js 22+, Python 3.11/3.12, and PostgreSQL 16+.
2. Create a private database and role, then copy `.env.example` values into the existing private `.env`. Before the first setup, set `ADMIN_USERNAME` and a 12+ character `ADMIN_INITIAL_PASSWORD`. Never commit `.env`.
3. Run `npm ci`. Its automatic setup creates `.venv`, installs the pinned CPU dependencies and `en_core_web_sm`, and verifies that the model loads. No administrator action is required, and later starts reuse the valid environment.
4. Run `npm run db:migrate`. This applies migrations and, only when no administrator exists, creates the initial account with an Argon2id password hash. Later deployments never change that account.
5. Remove `ADMIN_INITIAL_PASSWORD` from the environment after the first successful setup. `npm run admin:seed` remains available as an equivalent one-time recovery for an empty administrator table; it also refuses to overwrite an existing account.
6. Run `npm test`, `npm run worker:test`, and `npm start`. Startup verifies the worker again and waits for the model to become ready before accepting HTTP traffic.

Use `ADMIN_RESET_PASSWORD` with `npm run admin:reset-password` only from local server access for recovery. The command changes the hash and invalidates sessions. Never put real passwords in command history, documentation, screenshots, or release artifacts.

## Endpoints

- `GET /health` and `/healthz`: Express liveness only.
- `GET /ready`: real PostgreSQL and text-worker readiness.
- `GET /privacy`: published behavior statement; add a legitimate publisher contact before release.
- `POST /api/v1/installations`: anonymous random installation credential. Only its SHA-256 hash is stored.
- `POST /api/v1/analysis/jobs`: authenticated text-only analysis with an idempotency key and entry revision.
- `GET /api/v1/analysis/jobs/:id`: scoped status/result lookup.
- `POST /api/v1/analysis/jobs/:id/ack`: discard an in-memory delivered result.
- `DELETE /api/v1/analysis/jobs/:id`: scoped cancel/discard.
- `DELETE /api/v1/installation-data`: revoke the credential and delete operational records.
- `GET /api/v1/capabilities`: language/features and non-generative boundary.
- `GET /`: redirects to the administrator sign-in page.
- `/admin/login` and `/admin`: protected operational portal.

Admin sessions use PostgreSQL storage, request-aware Secure cookies behind the configured trusted proxy, HttpOnly/SameSite=Lax protection, rolling 30-minute expiry, rotation on login, CSRF tokens for changes, Argon2id password hashes, login throttling, and a per-user session version. Admin pages are never cached, and an expired sign-in form returns a fresh form instead of trapping the operator on an error response. The portal shows only operational identifiers, timings, health, status, and redacted codes.

## Process behavior

The default bind is `127.0.0.1:8787`, suitable when Nexus terminates HTTPS on the same Windows machine. Configure the actual host/port and narrow `TRUST_PROXY_HOPS` for the real proxy topology. `SIGINT`/`SIGTERM` stop acceptance, close the queue/worker, close PostgreSQL, and allow up to 15 seconds for shutdown. A restart marks queued/processing metadata as interrupted because memory-only payloads cannot survive it.

Inputs/results exist only in bounded process memory and expire after 15 minutes by default. Do not attach a disk-backed job queue or request-body logger. See `../docs/NEXUS_DEPLOYMENT.md`, `ML_PIPELINE.md`, and `SECURITY.md`.
