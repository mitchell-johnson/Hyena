# Hyena implementation record

Date: 10 September 2026. Branch: `feat/workers-foundation`. Baseline: Wildebeest commit `b056670a7204bc4d852c8a0cda9a3c9e39f8a0e1` in the user-provided [Hyena fork](https://github.com/mitchell-johnson/Hyena).

This is the first working milestone of the [complete build plan](build-plan.md). It is an early local posting server, not a finished federating Mastodon replacement. No production deployment or real mobile-client certification has taken place.

## Decisions applied

| Decision                    | Implementation and reason                                                                                                                                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No containers               | One Worker module, D1, R2, Queues, and a SQLite Durable Object. No Redis, Postgres, server VM, native media binary, or Stream subscription.                                                                             |
| Short media                 | Audio/video duration must be strictly below 60 seconds. A metadata parser checks the actual file before requesting transformations; an exact 60-second clip fails.                                                      |
| Keep Queues                 | D1 commits job intent with content. Queues provides delivery; a one-minute sweep repairs missed sends, queue expiry, and expired leases. An object with persistent storage is not an always-running JavaScript process. |
| Hibernating objects         | `StreamHub` stores WebSocket subscription/token state in socket attachments and revision cursors in SQLite. It has no polling loop or keepalive timer.                                                                  |
| Cheap media storage         | R2 stores originals temporarily and final derivatives. Successful processing removes originals. Unattached uploads expire after seven days. A five-MiB multipart buffer avoids whole-file buffering.                    |
| Current Cloudflare APIs     | Wrangler JSON config, declarative SQLite DO exports, nodejs compatibility, Rate Limiting, Images and Media bindings, Workers observability, and Workers-runtime tests.                                                  |
| Small initial account model | The database enforces exactly one local owner. Closed registration and explicit setup secret. Additional accounts and follower audiences are a later migration.                                                         |
| Safe incremental rollout    | Fresh D1 schema in `schema/`; old Wildebeest migrations are never applied to this database. Legacy code is retained as reference but excluded from runtime and CI.                                                      |

Cloudflare references: [DO lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/), [hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [Queues](https://developers.cloudflare.com/queues/), [Images binding](https://developers.cloudflare.com/images/optimization/binding/), [Media binding](https://developers.cloudflare.com/stream/transform-videos/bindings/), [Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/).

## Current behavior

| Area                  | Available                                                                                                                                                                                           | Still required for the release target                                                                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner login           | One-time setup, Argon2id password hashing, browser session, CSRF, origin checks, sign-out                                                                                                           | Recovery/export of identity, passkey/MFA evaluation, operator session controls, invited accounts                                                                                                                                    |
| App connections       | Dynamic app registration, exact redirect matching, consent, scoped opaque tokens, S256 PKCE, legacy confidential clients, client credentials, single-use codes, revocation, OAuth metadata/userinfo | Real app matrix, public-client edge cases, complete OAuth error/redirect equivalence, app management UI, push subscription keys                                                                                                     |
| Accounts and instance | Instance v1/v2, credentials, app verification, preferences, local lookup/profile                                                                                                                    | Profile editing, remote accounts, relationships, follows, lists, mute/block and notification settings                                                                                                                               |
| Posting               | Local text/media posts, content warnings, four stored visibility values, replies, edits, source, soft delete, idempotency, local/public/home/account timelines, reply context                       | Federation, recipient resolution, mentions/hashtags/link formatting, URL-weighted length, full edit/history/media attributes, polls, scheduling, boosts, favourites, bookmarks, pins, quotes                                        |
| Audience              | Public/unlisted readable anonymously; private/direct readable only by the owner                                                                                                                     | Private means followers and direct means resolved recipients in the finished server. This milestone does not send to either audience. Mentions are rejected so no user is told a message was delivered.                             |
| Media                 | Streaming v2 upload, asynchronous v1 polling, description/focus, R2 range reads, image pipeline, H.264/AAC MP4 video, MP3 passthrough, duration/size/pixel bounds, retry and orphan cleanup         | Live Images/Media corpus, GIF/WebM/MOV/HEVC/Ogg support assessment, metadata privacy, output codec/duration inspection, thumbnails and blurhash parity, old v1 upload, attached media editing, complete conditional/range semantics |
| Streaming             | Authenticated WebSocket `user`, `public`, `public:local`; subscriptions survive hibernation; token revocation closes sockets                                                                        | SSE, protocol-token auth, list/hashtag/direct/notification streams, fan-out across accounts, buffering limits, replay policy, federation events                                                                                     |
| Reliability           | Transactional outbox, leases, idempotent processing, retry backoff, dead job records, bounded sweeps                                                                                                | Destination federation delivery states, metrics/alerts, UI for retry/dead jobs, backup/restore drill, deletion/retention propagation                                                                                                |
| Federation            | None advertised or acknowledged                                                                                                                                                                     | WebFinger, actor keys, signatures, inbox/outbox, remote objects, follow lifecycle, delivery, updates/deletes, moderation and cross-server tests                                                                                     |

The target remains the pinned Mastodon 4.7.1 contracts in the full plan. An accepted OAuth connection does not certify an app: it may immediately call routes from later rows and receive an explicit error. Unsupported endpoints and composer features must not be counted as compatibility coverage.

## Data and failure behavior

IDs use a D1 sequence seeded from timestamp bits, always returned and serialized as decimal strings. Sorting uses a separate SQLite integer value. IDs never round-trip through a JavaScript number.

A posting batch writes the status, media references, revision snapshot, and job in one D1 transaction. Media ownership/readiness and attachment availability are checked inside that transaction. An operation-specific mutation token guards dependent statements, so a losing edit cannot append a revision or event. An idempotency key is unique per owner and retains a normalized request hash. Identical retries return the status; changed input or a deleted status produces a conflict. The initial key retention is indefinite, stricter than Mastodon's time-limited retention; expiration and exact replay-after-edit semantics remain a parity task.

Queue messages contain only `{version: 1, id}`. D1 is the source of truth. The consumer claims a five-minute lease and increments the attempt count. A temporary error schedules exponential retry in D1, then acknowledges the transport message. If persisting the result fails, the message is retried. Invalid input or eight failed attempts creates a durable `dead` record. Queue-level failures also have a configured dead-letter queue. Duplicate messages and expired leases are expected. This is at-least-once execution, not an exactly-once claim.

Media has `uploading → uploaded → processing → ready/failed` states. A record is reserved before R2 upload to make abandoned objects discoverable. The post API only accepts ready attachments. An ambiguous D1 commit leaves objects intact for recovery. Image/video transformation services are invoked by jobs, not by an HTTP upload that must stay open. A ready attachment has an unguessable capability URL usable by ordinary apps; knowing that URL grants byte access even if the status is private. Originals have no public route. This follows a capability delivery model, not per-download OAuth enforcement.

The original input is removed after a successful commit. Orphan cleanup claims old unattached rows before deleting objects so a simultaneous post cannot attach a disappearing object. Configure R2's abort-incomplete-multipart lifecycle as well: an isolate can disappear before it has a chance to abort an unfinished multipart operation. Deleted status media and old revision retention need the next cleanup milestone; they are not silently removed by the orphan sweep.

## Media limits and cost boundaries

The user constraint is **duration < 60 seconds**, not permission to truncate. The first accepted formats are JPEG, PNG, WebP, H.264 MP4 with optional AAC audio, and MP3. The advertised MIME list reflects this narrower acceptance. The upload ceiling is 40,000,000 bytes; images are limited to 40 megapixels, image outputs to 2048 pixels per side, videos to a 1920×1080 pixel matrix and an average 60 FPS. Up to four attachments are currently accepted; mixed-kind restrictions require Mastodon parity work.

MP3 is copied after validation to avoid paid transcoding. Embedded audio tags are preserved: remove sensitive tags before uploading. JPEG/PNG/WebP are transformed; the live corpus must verify metadata removal. Video is transformed once and a poster frame extracted once. Store derivatives in R2 and serve them, so each view does not trigger a conversion. A 59-second clip can cost approximately 60 transformation units including a frame; short does not mean free at arbitrary upload volume. The Media service's beta pricing/availability is a provider dependency, not a guaranteed permanent zero price. See the full plan for the dated cost model and published links.

The parser uses ranged R2 reads, a one-MiB cache, at most 256 reads and 80 MB of total requested bytes per probe. Those conservative budgets intentionally reject pathological inputs. The five-MiB upload buffer bounds one operation's memory, not total isolate memory across concurrent requests. Concurrency and CPU measurements remain a release gate.

## Verification and remaining gates

`npm run check` runs strict TypeScript checking, the Workers-runtime integration suite, and a deploy dry-run. Tests cover the owner/OAuth round trip, PKCE failure, concurrent code redemption, token revocation, CSRF and scope boundaries, concurrent status idempotency, privacy, mutation behavior, media attachment races, queue outage/lease recovery, media parsing/processing failures, R2 byte ranges, orphan cleanup, and hibernation.

D1, R2, and Durable Objects run in local workerd. The queue send boundary and remote image/video transformation services are explicit test doubles; no passing local test should be represented as a live Cloudflare deployment, production queue test, or codec conversion certification. Synthetic media fixture generation is documented in `tests/fixtures/README.md`.

Before public use: run provider tests in a temporary Cloudflare environment, measure password/media CPU and peak memory, exercise actual Queues/cron/DLQ, verify storage cleanup and restore, finish federation and privacy delivery, and test the complete app matrix. The current runtime deliberately has no public ActivityPub inbox that could acknowledge and discard remote activities.

## Next implementation order

1. Run the short-media provider corpus and app OAuth smoke tests on a temporary canonical HTTPS domain. Capture traces with tokens removed. Fix media error/status/metadata mismatches first.
2. Introduce actors, keys, recipients, follows, object/activity storage and destination delivery jobs; implement and test WebFinger, signed federation and the complete follow/create/update/delete lifecycle against the pinned Mastodon reference.
3. Build home timeline fan-out, remote discovery/formatting, favourites/boosts/bookmarks, notifications, moderation, and recipient-aware reads. Extend the current transactional outbox rather than adding best-effort fetches.
4. Complete polls, scheduling, edit/history/media semantics, quotes, lists, filters, SSE, Web Push, and account settings. Add cases to the API ledger and certify selected current apps.
5. Build owner/operator controls, durable export/backup/restore, retention and cost alerts; measure the supported personal-instance envelope. Enable production only after the full plan's release gates pass.

No project phase is marked complete merely because a subset of its files exists. This branch starts P1/P2/P3/P5 work; P0 provider/client spikes remain open.

## Toolchain verification

Pinned on the research date: Wrangler 4.130.0, Cloudflare Vitest plugin 1.1.6, Workers types 5.20260908.1, Vite 8.2.2, TypeScript 7.0.2, and Vitest 4.1.11. Vitest 5 is outside the Cloudflare plugin’s declared peer range and is not used. The test resolver skips `browser` main-field mappings: Mediabunny’s `browser:false` Node helper otherwise becomes an invalid empty builtin in Vitest. No installed dependency is patched. The production Wrangler bundle uses normal Workers resolution.

The 11 integration tests and dry-run pass with this pinned combination. The local test runtime prints a `deleteAllDurableObjects()` diagnostic during intentional storage teardown; the test process exits successfully. This is not a production exception from the application.

Invocation logs are disabled because OAuth codes and WebSocket access tokens can appear in query strings. Application errors log only a generated request ID and an error type. Do not enable URL/body logging when running real-client traces.
