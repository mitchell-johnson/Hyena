# Hyena

A personal Mastodon-compatible server being built on Cloudflare Workers, D1, R2, Queues, and hibernating Durable Objects. Forked from [Wildebeest](https://github.com/cloudflare/wildebeest). No containers or always-on server.

**Status: first implementation milestone, for development.** Owner login, OAuth app authorization, local posting, durable jobs, short-media processing, and basic WebSocket streams are implemented. Federation, the complete Mastodon API, and real app certification are still being built. Connecting an app may succeed while features it subsequently requests are unavailable.

Read the [complete build plan](docs/build-plan.md) and [implementation/compatibility record](docs/implementation.md).

## Run locally

Use Node.js 24 or newer.

```sh
npm ci
cp .dev.vars.example .dev.vars
npm run db:migrate
npm run dev
```

Set a long random `SETUP_TOKEN` in `.dev.vars`, then open `http://localhost:8787/setup` to create the owner. Setup closes permanently after the first account is created. Login uses an ordinary password and OAuth consent; Cloudflare Access is not required.

Run `npm run check` for TypeScript checks, integration tests, and a Wrangler deploy dry-run. Tests need no Cloudflare credentials. Local text posting works without remote media services; image/video processing requires access to the Cloudflare Images/Media services. Test providers are used only in the integration suite. Failed media work remains in the durable job ledger.

## Create a development deployment

Start with new resources. The new schema is incompatible with an existing Wildebeest D1 database.

```sh
npx wrangler login
npx wrangler d1 create hyena
npx wrangler r2 bucket create hyena-media
npx wrangler queues create hyena-dead-letter
npx wrangler queues create hyena-jobs
```

Configure `wrangler.jsonc` with the returned D1 `database_id`, your canonical HTTPS `PUBLIC_ORIGIN` (no trailing slash), and your resource names. Configure a Worker custom domain matching that origin. Use the same origin for setup/login and for app connections; do not later change it after federation identity is established.

Enable the Images/Media services for the account and confirm their current availability and billing. Configure R2 to abort incomplete multipart uploads after one day, retain final authored media, and keep the bucket private with no `r2.dev` or public custom-domain access. The Worker serves processed capability URLs. The runtime removes processed originals and seven-day-old unattached uploads.

```sh
node scripts/check-deploy.mjs
npm run db:migrate:remote
npm run deploy
npx wrangler secret put SETUP_TOKEN
```

Use a random setup secret, create the owner through `/setup`, then remove the secret with `npx wrangler secret delete SETUP_TOKEN`. If setup is not yet configured the endpoint returns an explicit unavailable error. The deploy script rejects the checked-in placeholder database/origin. Deployment is manual; commits and pull requests run checks only.

The optional GitHub deployment workflow uses a `development` environment and `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets. Provision resources and configure the domain before running it. It applies the new D1 migrations and deploys the selected branch. It does not enable federation or turn this alpha into a production-ready instance.

## Media and costs

- Audio and video must be **strictly shorter than 60 seconds**; longer files are rejected, not truncated.
- Current formats: JPEG, PNG, WebP, H.264 MP4 with optional AAC, and MP3. Other formats still need implementation and provider testing.
- Maximum upload: 40,000,000 bytes. Images: 40 megapixels, with processed output bounded to 2048×2048. Video: 1080p pixel matrix and average 60 FPS.
- Media uploads return an asynchronous attachment. Poll `/api/v1/media/:id` until ready before posting. Processing errors return 422; pending uploads return 206.
- MP3 uses pass-through after validation to avoid a conversion charge. Embedded tags remain; remove sensitive audio metadata before upload.
- Processed media uses unguessable URLs. Anyone holding a URL can fetch those bytes. API visibility checks protect discovery of private statuses, not a leaked capability URL.

The design targets the approximately **US$5/month Workers Paid baseline** at small usage, plus a domain and charges above included allowances. This is a budget target, not a measured bill. Store transformed media once in R2 so views do not repeatedly pay for conversion. A 59-second video still consumes transformation work; monitor upload volume and beta Media pricing. See the [dated cost model](docs/build-plan.md#15-cost-model-and-cost-controls).

Queues is retained because it handles retries and delivery cheaply at this scale. Durable Objects hibernate and keep persistent state; they are not immortal running processes. D1's transactional outbox protects committed work if Queues is temporarily unavailable.

## Repository layout

| Path                                                                            | Purpose                                                        |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `src/`                                                                          | New Worker, OAuth, posting, media, jobs and stream hub         |
| `schema/`                                                                       | Fresh Hyena D1 migrations                                      |
| `tests/`                                                                        | Workers-runtime integration tests and synthetic media fixtures |
| `wrangler.jsonc`                                                                | Single Worker and native Cloudflare bindings                   |
| `docs/build-plan.md`                                                            | Full researched architecture and release backlog               |
| `docs/implementation.md`                                                        | Delivered behavior, limitations and next milestones            |
| `backend/`, `functions/`, `frontend/`, `consumer/`, `do/`, `migrations/`, `tf/` | Historical Wildebeest reference, excluded from the new build   |

The [original README](docs/wildebeest-readme.md), source history, Apache-2.0 license and notices are retained. Historical client support claims apply to Wildebeest, not to this fresh implementation.
