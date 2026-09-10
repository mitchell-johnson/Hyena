# Contributing to Hyena

Bug reports should include the Hyena version, browser or Mastodon app and version, steps to reproduce, and the result you expected. Remove passwords, tokens, and private post contents from diagnostics. Use the [security reporting instructions](SECURITY.md) for vulnerabilities.

## Run locally

Install Node.js 24 or newer and the pinned dependencies:

```sh
npm ci
cp .dev.vars.example .dev.vars
```

Replace the two example secrets with separate random values. Keep `.dev.vars` private. Then initialize the local database and start Hyena:

```sh
npm run db:migrate
npm run dev:local
```

Open `http://localhost:8787/setup`, enter your local setup token, and create the owner account. Sign in to use the web interface and Administration.

`dev:local` uses local D1, R2, Queues, and Durable Objects. It omits account-dependent Images and Media transformations. To exercise those services with your Cloudflare account, configure your own resources as described in the [operations guide](docs/operations.md), then use `npm run dev`.

## Check changes

```sh
npm run check
```

This runs TypeScript checks, integration tests in workerd with local Cloudflare bindings, a SQLite backup round-trip test, and a Wrangler deployment dry run. It does not deploy. Remote provider and transport calls are substituted in the integration tests; verify relevant real services separately when changing those integrations.

Use `npm run test:watch` while working on runtime behavior. Format changed files with Prettier. For web changes, follow the [local browser check](docs/operations.md#local-browser-check) and check both desktop and mobile layouts.

## Project layout

| Path             | Purpose                                                                  |
| ---------------- | ------------------------------------------------------------------------ |
| `src/`           | Worker, Mastodon APIs, federation, account security, and background jobs |
| `public/`        | Web client and static assets                                             |
| `schema/`        | Ordered D1 migrations                                                    |
| `tests/`         | Runtime integration tests and synthetic media fixtures                   |
| `scripts/`       | Local development, provisioning, backup, and verification tools          |
| `docs/`          | Operations, compatibility evidence, architecture, and dependency notices |
| `wrangler.jsonc` | Cloudflare deployment configuration                                      |

Keep migrations additive once released, and preserve existing account identities and encryption keys. Include a focused regression test for behavior changes. Pull requests should explain the user-visible problem, the resulting behavior, and the checks performed.

The CI workflow checks pushes and pull requests. Deployment is a separate, manual workflow; merging to `main` does not deploy an instance. See the [deployment and recovery guide](docs/operations.md) before operating on live data.
