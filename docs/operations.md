# Deploying and operating Hyena

This runbook accompanies `0.2.0-alpha.1`, dated 10 September 2026. The repository's local integration/build/browser checks have run; the Cloudflare provisioning, production deployment, native clients, real providers and recovery drill below have **not** run. Keep the compatibility-verification flag false until the [acceptance checklist](implementation.md#external-acceptance-checklist) passes.

Use a fresh installation. Do not apply these migrations to an old Wildebeest database. Its database, actor identities and hosted media require a separately rehearsed import if an existing live instance is involved. The old Terraform and deployment button are historical source, not the new provisioning path.

## Resources and configuration

Use the pinned lockfile with Node.js 24+. The selected baseline uses Workers Paid, a new D1 database, a private R2 bucket, two Queues, a SQLite Durable Object namespace, Images and Media bindings. Static browser assets are served by the Worker asset binding. Containers, VMs, Redis, PostgreSQL, managed Stream storage, Workflows, Workers AI and read replicas are not required. See the [architecture/cost assessment](build-plan.md) for the service decisions and dated prices.

| Setting/binding                          | Purpose and operational requirement                                                                                                                                                                             |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_ORIGIN`                          | Canonical HTTPS origin, without a trailing slash/path. Configure the permanent domain before accepting real follows or posts. Changing this does not migrate identities.                                        |
| `DB`                                     | New D1 database named in `wrangler.jsonc`; the provisioner records its UUID. All migrations in `schema/` must apply.                                                                                            |
| `MEDIA_BUCKET`                           | Private R2 bucket. Do not enable `r2.dev` or public bucket access: originals and account archives share the bucket with processed derivatives.                                                                  |
| `JOBS`                                   | Work queue. Queue bodies are versioned job references; content and retry state remain in D1.                                                                                                                    |
| Queue consumer                           | Batch size 10, concurrency 2, transport retries 5, with a separately provisioned dead-letter queue. Application retry policy is independent of transport retries.                                               |
| `STREAMS`                                | SQLite `StreamHub` DO class using current Wrangler `exports` configuration. Keep the namespace stable across deployments.                                                                                       |
| `IMAGES` / `MEDIA`                       | Real account-enabled native transformations. Provider errors stay visible as failed media jobs. Confirm Media beta access and billing in the target account.                                                    |
| `KEY_ENCRYPTION_SECRET`                  | A stable, random secret at least 32 characters long. Protects actor signing keys, VAPID state and sensitive queued data. Preserve it independently of D1.                                                       |
| `SETUP_TOKEN`                            | Separate random, one-time owner setup credential. Remove it after setup; do not remove the encryption secret.                                                                                                   |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Optional paired base64url P-256 public point and private scalar. If omitted, Hyena generates and encrypts persistent VAPID keys in D1. Do not rotate them casually; existing push subscriptions depend on them. |
| `VAPID_SUBJECT`                          | Optional contact URI (`mailto:` or HTTPS); set an owner contact for push delivery.                                                                                                                              |
| `CONTACT_EMAIL` / `EMAIL`                | Sender address and optional transactional Email Service binding. Complete sender-domain onboarding and a real delivery test.                                                                                    |
| `REGISTRATIONS`                          | Closed when unset. `open` permits confirmed accounts; `approved` additionally requires moderator approval. Email must be available. Owner-created bounded invitations are supported.                            |
| `MAX_MEDIA_BYTES`                        | Default 40,000,000; images have a separate 20 MB input ceiling. Byte ceilings do not replace duration/codec/pixel checks.                                                                                       |
| `AUTH_LIMITER`                           | Native rate-limiter binding. Keep the configured namespace stable and review auth abuse metrics.                                                                                                                |
| `MAINTENANCE_MODE`                       | String `true` pauses application requests and job consumption/sweeps. `/health/live` remains available and reports maintenance. Used during coherent D1/R2 backups and recovery.                                |
| `TRANSLATION`                            | Optional service binding implementing the internal translation contract in `community.ts`; absent by default. Translation is advertised as disabled unless it is configured.                                    |

Example custom-domain additions to `wrangler.jsonc`, after replacing the sample with a zone you control:

```jsonc
"workers_dev": false,
"preview_urls": false,
"routes": [{ "pattern": "social.example.com", "custom_domain": true }]
```

Keep native apps and federation outside interactive browser challenges/Cloudflare Access rules. OAuth redirects, `/api/`, `/.well-known/`, ActivityPub inboxes and signed fetch must work for ordinary HTTP clients. Configure HTTPS and DNS for the actual origin, then test the origin rather than only a preview URL. Do not expose two independent active instances with the same actor identity.

## Provision and deploy

Run these commands from the repository root. Obtain an account-scoped Cloudflare token for the D1, R2, Queues and Worker operations required by your chosen release path. Limit zone access to the intended custom-domain zone. Load credentials through your environment or credential manager; never put tokens in `wrangler.jsonc` or commit them.

```sh
npm ci
npm run provision
```

The first provision command is a plan: it prints configured resource names without making API calls or mutations. Configure `PUBLIC_ORIGIN`, resource names and the custom domain first. Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, then:

```sh
npm run provision -- --execute
npm run check
npm audit --omit=dev
node scripts/check-deploy.mjs
npm run db:migrate:remote
npx wrangler secret put KEY_ENCRYPTION_SECRET
npx wrangler secret put SETUP_TOKEN
npm run deploy
```

`--execute` creates missing D1/R2/Queue resources and writes the D1 UUID back to the configuration. It does not enable account beta services, buy a domain, install email DNS records, deploy the Worker, or delete/recreate existing resources. Review the resulting configuration diff. If you rename resources, treat that as a distinct deployment; names are not an in-place data migration.

The deploy script refuses a placeholder database or noncanonical HTTPS origin. This is a configuration check, not proof of account binding availability. Images/Media must be enabled in the account before a full production deploy. No live account validation was possible during implementation.

Open `/setup`, supply the one-time token, create the owner and sign in. Verify `/health/ready`, `/api/v2/instance`, owner WebFinger and the actor document. Check that actor key IDs/public values remain unchanged after a redeploy. Then:

```sh
npx wrangler secret delete SETUP_TOKEN
```

The manual GitHub `Deploy development instance` workflow runs the checks, migration and deploy path. It expects account secrets in the configured `development` environment. It never runs merely because a PR is updated. Review migrations and take a backup before using it on a populated instance. The draft PR is not a deployment or merge authorization.

## Email, push and optional services

Add an Email binding after onboarding a sender domain:

```jsonc
"send_email": [{ "name": "EMAIL", "allowed_sender_addresses": ["hyena@example.com"] }]
```

Set `CONTACT_EMAIL` to that permitted sender. Hyena uses the current structured `send({ from, to, subject, text })` Workers API through the durable outbox. Cloudflare's binding documentation describes sender/recipient restrictions, including verified-destination requirements for some configurations. Test confirmation, reset and change-email delivery to the addresses your account is permitted to send to before opening registration; a successful enqueue is not proof of delivery. [Binding configuration](https://developers.cloudflare.com/email-service/configuration/send-bindings/), [Workers sending API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/).

Cloudflare currently lists 3,000 outbound emails per month included on Workers Paid, then US$0.35 per 1,000. Recheck the account's quotas and beta conditions before relying on that allowance. [Email pricing](https://developers.cloudflare.com/email-service/platform/pricing/).

Enable browser notifications in Settings after configuring a valid VAPID contact. HTTPS and browser permission are necessary. Each native app can maintain its own scoped subscription. Test a real push endpoint, expiration, revoked token, disabled account and logout; the local crypto round-trip test verifies encryption format, not APNs/FCM/browser delivery.

Donation campaigns, annual-report campaigns, languages and optional translation are instance configuration. An absent optional service returns the documented disabled/empty behavior. Do not make paid translation calls by default. An enabled translation adapter must preserve the Mastodon response shape, sanitize translated HTML and have its own measured cost bound.

## Cost and maintenance controls

Owner settings in `/admin` include these application accounting limits:

| Key                        |       Default | Meaning                                              |
| -------------------------- | ------------: | ---------------------------------------------------- |
| `monthly_media_bytes`      | 1,073,741,824 | Newly accepted uploaded bytes per UTC month          |
| `monthly_image_transforms` |         5,000 | Logical image operations per UTC month               |
| `monthly_media_seconds`    |         5,000 | Logical processed media seconds per UTC month        |
| `max_accounts`             |            10 | Local registration capacity; owner setup is separate |

Confirm the settings against the live configuration. Usage charges use durable IDs to prevent one application operation being counted twice. These counters do not represent the complete Cloudflare bill; provider retries, CPU, database rows, queue operations and storage have separate billing. Monitor the actual account dashboard and set billing notifications there. No billing alerts or recurring external automations were created during implementation.

Keep the private R2 bucket's abandoned multipart-upload cleanup enabled. Do not add a blanket object-expiration rule to `public/`: it would delete media still referenced by posts. Application cleanup handles unreferenced uploads, deleted media, expired exports and completed job receipts. The default retention favors a personal installation; measure database growth instead of assuming that remote metadata remains small indefinitely.

Durable Objects persist their state and can hibernate WebSockets; the JavaScript process is not permanently running. Queues supply wakeup/delivery/retry behavior, while D1's job rows provide recovery. Removing Queues would require another durable execution design, not a permanently alive DO. SSE keeps active request work and should be measured separately from hibernating WebSockets. [DO lifecycle](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/), [Queue billing](https://developers.cloudflare.com/queues/platform/pricing/).

## Diagnose failed work

`/admin` shows job states and failed jobs, media totals and usage counters. The corresponding owner APIs are `/api/hyena/admin/health`, `/api/hyena/admin/jobs` and `/api/hyena/admin/settings`. Their role and scope checks apply to native app tokens too. Inspect bounded error summaries without exporting private activity bodies or credentials into logs.

| Symptom                                 | Check and action                                                                                                                                                                                                        |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accepted posts have not federated       | Check cron execution, pending job age, Queues consumer binding, current destination moderation and remote HTTP errors. D1 job intent remains authoritative.                                                             |
| Repeated destination failure            | Let exponential retries handle temporary failures. Confirm DNS/TLS and the remote response. Seven days/100 attempts after first execution is the terminal application bound.                                            |
| Dead job                                | Resolve its cause, then use the administrator Retry action. Retry resets its attempt window. Replaying an already successful remote mutation can have external effects, so inspect the job kind and stable activity ID. |
| Transport dead-letter messages          | Compare their job IDs with D1 state. The periodic sweep repairs orphaned queue references; it does not need the full payload from the dead-letter message. Do not blindly duplicate an entire queue into the consumer.  |
| Media remains processing/failed         | Check codec/duration bounds, monthly budgets, provider activation and transform responses. Correct the cause before retrying. An unsupported codec is a validation failure, not a reason to retry a paid transform.     |
| Streams stop                            | Reconnect with a current token and fetch the timeline/markers. Verify WebSocket upgrade and token revocation. Do not assume an indefinite replay history.                                                               |
| Login works but a client callback fails | Check exact registered redirect URI, scheme, S256 verifier, token scope, canonical origin and platform callback association. Never fix it with wildcard redirects.                                                      |
| Email job fails                         | Check sender-domain onboarding, binding restrictions, quota/suppression and provider error. Do not weaken confirmation checks to compensate for mail setup.                                                             |
| D1/R2 growth or rising costs            | Review row scans, remote metadata retention, uploads and transformation budgets before increasing resources. No full-text indexing cluster or remote-media mirror is provisioned.                                       |

A domain suspension or personal domain block now records affected accepted relationships, removes follows/list memberships and emits a `severed_relationships` notification. Settings → Import and export provides owner-only CSV downloads. Unblocking does not silently refollow accounts; the owner can review and reimport the following CSV when policy allows. Account suspension records the same loss with its own event type.

## Backup and restore

D1 Time Travel provides automatic recovery history (30 days on Workers Paid, 7 on Free), but restores a database **in place** and does not restore R2 objects or independent secrets. Save a bookmark before schema changes and preserve the current state before attempting an in-place recovery. [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/).

```sh
npx wrangler d1 time-travel info DB
```

For a coherent independent D1/R2 snapshot:

1. Set `MAINTENANCE_MODE` to string `true` in Wrangler vars and deploy that configuration. Confirm `/health/live` reports `maintenance: true`; mutation requests return 503. Keep maintenance in the reviewed release configuration until the snapshot has completed.
2. Allow existing HTTP requests and active job leases to drain. Pause manual SQL writers and other administrative resource changes. The backup script refuses active job leases. Since the exporter pages across several database calls, no writer may run while it reads.
3. Install AWS CLI v2 and load bucket-scoped R2 S3 credentials into `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`; set `AWS_DEFAULT_REGION=auto`. Also provide `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. Use the bucket's actual endpoint/jurisdiction if it differs from the standard account endpoint used by the script. [R2 AWS CLI setup](https://developers.cloudflare.com/r2/examples/aws/aws-cli/).
4. Choose a new output directory on an encrypted disk, outside the Git repository, then run:

```sh
node scripts/backup.mjs backup /secure/hyena-2026-09-10
node scripts/backup.mjs verify /secure/hyena-2026-09-10
```

The directory contains `database.sql`, downloaded R2 objects, HTTP/custom metadata and a SHA-256 manifest. The exporter serializes SQLite values into SQL **inside D1** so 64-bit sequence values cross the JSON interface as text. It does not rely on the standard export path's documented JavaScript numeric-precision behavior. It refuses virtual tables and checks foreign keys. Text is hex-encoded to preserve embedded nulls. Large text/blob values use a temporary restore buffer table and bounded SQL statements; it is removed at the end of the import. The Node/SQLite round-trip test verifies these paths. [D1 import/export limitations](https://developers.cloudflare.com/d1/best-practices/import-export-data/).

The backup contains private posts, email information, password verifiers, tokens and encrypted identity data. The script does not encrypt the whole archive; use encrypted storage or encrypt it with your existing backup tool before copying it off the machine. Keep `KEY_ENCRYPTION_SECRET` and any externally supplied VAPID keys in your separately recoverable secret store. A checksum is an integrity check, not encryption or authentication against a maliciously rewritten manifest.

Once verification succeeds, set `MAINTENANCE_MODE=false`, redeploy and confirm that due jobs resume. Save the deployed commit, schema migration list, origin, resource IDs and secret-store reference with your backup. The script never removes the source objects.

Restore into **different, empty** D1/R2 resources created for the recovery. Do not point active production traffic or consumers at them during a drill. Preserve the original origin/actor keys in the data while keeping execution isolated; changing the origin to a staging domain is not a valid identity-preserving restore test.

```sh
node scripts/backup.mjs restore /secure/hyena-2026-09-10 hyena-recovery hyena-media-recovery
node scripts/backup.mjs restore /secure/hyena-2026-09-10 hyena-recovery hyena-media-recovery --execute
```

The first command verifies the manifest and prints a plan. The executing command refuses nonempty targets, uploads object bytes with saved metadata, then imports SQL. It does not modify the original database/bucket, change DNS, enable a consumer or cut over the Worker. A partial failure leaves isolated targets to inspect; it does not automatically delete them or retry over a nonempty database.

Before cutover, check foreign keys, exact IDs, record counts, media checksums/metadata, actor public keys and the ability to decrypt private keys. Review outstanding jobs and revocations accepted after the snapshot; an old backup can resurrect tokens or forget a deletion unless reconciled. Replay against an isolated peer before permitting public delivery. Quiesce the old writer, bind the recovered resources to the single canonical instance, restore secrets, then resume processing and verify clients. No RPO/RTO guarantee is established until this drill succeeds.

## Upgrade and rollback

Record the current deployed version and backup/bookmark. Review each SQL migration for compatibility before applying it. Deploy additive schemas before code that needs them. Keep immutable actor/object IDs, signing keys, Queue payload versions and DO namespace identifiers stable. A code rollback does not reverse a schema mutation, undo an email or retract a federation effect.

The new SQLite DO class uses Wrangler `exports`. Do not mix this configuration with a copied legacy DO migration block, rename/delete the class casually or assume a gradual deployment can undo a namespace change. Review the current platform restrictions for a namespace-affecting release. [DO migrations/class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/).

If the new code fails against an additive schema, roll back only to a code version that can operate on that schema. For incompatible data changes, keep maintenance enabled and choose a forward fix or the tested recovery procedure. Keep old resources until the recovery window has closed. Dependency/compatibility-date upgrades require the runtime and protocol checks before release.

## Local browser check

`npm run dev:local` binds to loopback and generates a temporary config with local origin/D1/R2/Queues/DOs. It excludes Images, Media, Email and service bindings so the core browser app can run without a Cloudflare account. `.dev.vars` holds disposable setup/encryption values. This path does not prove provider-backed media or email behavior. `npm run dev` uses the configured full bindings for provider tests.

Start with a disposable local database/account, apply migrations and run the server. Install Playwright separately for browser QA (it is not a production dependency):

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
```

Set `HYENA_TEST_USERNAME`, `HYENA_TEST_PASSWORD`, and `HYENA_TEST_SETUP_TOKEN` to the disposable account/setup values. In another terminal:

```sh
node scripts/browser-smoke.mjs
```

The script accepts `PLAYWRIGHT_MODULE` and `CHROMIUM_EXECUTABLE` for an existing local installation, and rejects non-loopback `HYENA_TEST_ORIGIN`. It creates a post, visits the principal views/settings, checks desktop/mobile overflow and records browser errors. Ignored `test-results/` contains screenshots and the JSON report. The implementation run used Chromium 152, reported zero JS errors/5xx and no horizontal overflow at 390 pixels. It did not exercise a physical passkey, native client, browser push delivery or real provider transformations.

## Evidence required for release

Use the detailed [compatibility record](implementation.md) and [full build plan](build-plan.md). Preserve actual client/platform versions, request/response fixtures, peer delivery results, provider corpus outputs, measured usage and the restore drill. All C01–C32 feature areas have implementation; that is distinct from proving every Mastodon behavior. Do not advertise full API level 11 or a production compatibility guarantee merely because route registration and local tests pass.
