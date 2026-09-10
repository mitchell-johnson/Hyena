# Hyena

A small federated social server for **Cloudflare Workers, D1 and R2**, with Queues for background delivery and hibernating Durable Objects for streams. Forked from [Wildebeest](https://github.com/cloudflare/wildebeest). No containers, Redis, PostgreSQL, VM, or always-running process.

**0.2.0-alpha.1 — implementation available, production compatibility unverified.** The Worker implements the Mastodon 4.7.1 REST route inventory, ActivityPub federation, OAuth app connections, posting and interactions, short media, collections and quotes, streaming/push, account security, administration, and a first-party web client. Route coverage does not establish complete behavioral equivalence or certify a native app. No Cloudflare deployment has been performed.

- [Full architecture and build plan](docs/build-plan.md)
- [Feature inventory, evidence and compatibility limits](docs/implementation.md)
- [Deployment, recovery and operation](docs/operations.md)
- [Pinned Mastodon REST routes](docs/mastodon-routes.json)

## Develop

Node.js 24 or newer:

```sh
npm ci
cp .dev.vars.example .dev.vars
npm run db:migrate
npm run dev:local
```

Replace both example secrets with different random values. Open `http://localhost:8787/setup`, create the owner, then sign in. `dev:local` uses local D1/R2/Queues/DOs and omits the account-dependent Images/Media bindings. Use `npm run dev` with a connected Cloudflare account to exercise those providers. Integration tests substitute only remote providers and transport sends.

```sh
npm run check
npm audit --omit=dev
```

The checks run TypeScript, workerd integration tests, a lossless SQLite snapshot test, and a Wrangler deployment dry-run. They do not deploy anything. Browser smoke instructions are in [operations](docs/operations.md#local-browser-check).

## Deploy a development instance

Use **fresh resources**. Historical Wildebeest databases and Terraform are incompatible with this runtime.

1. Set the canonical HTTPS `PUBLIC_ORIGIN`, resource names and custom domain in `wrangler.jsonc`. Treat the domain and actor identities as permanent.
2. Review `npm run provision`. With account credentials configured, `npm run provision -- --execute` creates missing D1/R2/Queue resources and records the D1 ID. It does not deploy the Worker.
3. Set a stable `KEY_ENCRYPTION_SECRET` before creating actor keys, sessions, VAPID keys or accounts. Back it up separately. Set `SETUP_TOKEN` for one-time owner setup.
4. Enable Images and Media bindings in the Cloudflare account. Configure optional Email Service if registration or password-reset email is wanted.
5. Follow the [deployment runbook](docs/operations.md), run the checks, apply migrations, then deploy. The GitHub deployment workflow is manual.

After owner setup, remove **only** `SETUP_TOKEN`. Removing or replacing `KEY_ENCRYPTION_SECRET` makes encrypted identity keys and credentials unreadable. Registration is closed by default; invited/open/approval-based local accounts are supported.

## Media and costs

Audio, video, and animated images must be **strictly shorter than 60 seconds**. Exact 60-second files are rejected. The input is probed before a paid transformation; it is not silently clipped.

Supported input is explicitly advertised: JPEG, PNG/APNG, WebP, GIF, HEIC/HEIF, H.264/AAC MP4 and MP3, subject to the actual configured limits. Uploads are capped at 40 MB; image input is additionally capped at 20 MB. Static images are limited to 40 MP, animations to 50 MP across frames, and video to a 1080p pixel matrix / average 60 FPS. Other codecs and containers are rejected. MP3 is remuxed without tags. Images and video use native bindings; successful processing deletes originals and stores reusable derivatives in R2. No FFmpeg service or Stream subscription is provisioned.

Media URLs are unguessable capabilities. Possessing a URL permits byte access; OAuth controls private-post discovery, not a copied media URL. The R2 bucket must remain private.

The cost target is the **US$5/month Workers Paid baseline**, plus the domain, optional services and usage beyond included allowances. It is not a measured bill. The Media binding is currently a beta with no binding billing; this is not a promise of permanent free conversion. See the [dated cost assessment](docs/build-plan.md#15-cost-model-and-cost-controls). Application budgets bound uploads and transformations; they are not an account-wide billing cap.

Queues remains useful: a Durable Object has durable state but can hibernate or be evicted. It is not an immortal running worker. D1 stores committed job intent; Queues delivers references; a periodic sweep repairs lost sends and retries. See the [delivery design](docs/implementation.md#delivery-and-consistency).

## Source layout

| Path                                                                            | Purpose                                                      |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `src/`, `public/`                                                               | Worker and first-party client                                |
| `schema/`                                                                       | New, ordered D1 migrations                                   |
| `tests/`, `scripts/test-backup.mjs`                                             | Runtime and snapshot tests                                   |
| `scripts/`                                                                      | Provisioning, browser checks, backup, restore and notices    |
| `wrangler.jsonc`                                                                | Cloudflare bindings and runtime configuration                |
| `docs/`                                                                         | Plan, compatibility record, operation and dependency notices |
| `backend/`, `functions/`, `frontend/`, `consumer/`, `do/`, `migrations/`, `tf/` | Historical Wildebeest source; excluded from the new build    |

Apache-2.0 and upstream notices are retained. See [runtime dependency notices](docs/third-party-notices.md) and the [historical README](docs/wildebeest-readme.md). Historical Wildebeest client claims do not certify Hyena.
