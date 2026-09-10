# Hyena

Your own home on the fediverse. Hyena lets you post, follow people on other servers, and keep a social address on a domain you control. Use the built-in website or connect a Mastodon app.

Hyena is designed for a personal server or a small community, hosted on Cloudflare. **It is currently alpha software (`0.2.0-alpha.1`).** App compatibility and live federation are still being tested; see the [compatibility notes](docs/implementation.md) for what has been verified.

## What you can do

- **Share and join conversations.** Write and edit posts, reply, boost, favourite, bookmark, and create polls or scheduled posts.
- **Find your people.** Follow accounts across the fediverse, browse timelines and hashtags, and organize your reading with lists and collections.
- **Choose your audience.** Publish publicly, to followers, or to people you mention. Use content warnings, filters, mutes, and blocks.
- **Share photos and short clips.** Add media descriptions for accessibility. Audio, video, and animated images must be shorter than 60 seconds; uploads are limited to 40 MB, or 20 MB for images.
- **Manage your account.** Edit your profile, connect or revoke apps, use two-factor authentication or passkeys, and import or export account data.

The web interface works on desktop and mobile. Administrators can manage invitations, accounts, reports, server rules, and background jobs from **Administration**.

## Start using Hyena

Open your server's website and choose **Sign in**. Registration is closed by default; if you do not have an account, ask the server owner for an invitation. If you are setting up your own server, follow the hosting guide below to create its first account.

After signing in, update your profile in **Settings**, search for someone using their full address (such as `@someone@their-server.example`), and follow them. Their new posts will appear in **Home**.

The follow button shows **Requested** while the other server processes the request or the person approves it, then **Following** once accepted. Select it again to cancel or unfollow. If your profile requires follower approval, incoming requests are under **Notifications → Follow requests**.

When a new follower from another server is accepted (automatically unless your profile requires approval), Hyena shares up to 20 of your recent public posts with their original dates and delivers future posts normally. These recent posts can take a few minutes to arrive; to find an older post, search for its exact URL.

### Connect a Mastodon app

1. In the app, choose to sign in to an existing account.
2. Enter your Hyena server's website hostname, such as `social.example.com`.
3. Sign in on the Hyena page, review the requested permissions, and select **Authorize app** to return to the app.

Your account address and server hostname can differ. For example, `@you@example.com` might use `social.example.com` for app sign-in. The **Connect a Mastodon app** page on your server shows the hostname to enter and lets you revoke access later.

If authorization stalls, close the sign-in screen and start again to load the latest page. Include the app name, device, and error when [reporting a problem](https://github.com/mitchell-johnson/Hyena/issues). Individual apps may expose features that Hyena has not yet fully verified.

## Host your own server

You will need a Cloudflare account with Workers Paid, a domain you control, and Node.js 24 or newer to run the setup tools. Hyena stores account data in D1 and media in R2, with Cloudflare services handling background work and live updates.

The [hosting guide](docs/operations.md#provision-and-deploy) walks through configuring your domain, creating resources, setting secrets, deploying, and creating the owner account. Start with a fresh database and choose a domain you intend to keep. The repository's `wrangler.jsonc` describes the maintainer's deployment: replace its account, domains, and resource settings before provisioning your own.

Registration stays closed until you choose otherwise. Invitations are available in Administration; open registration and password-reset email require an email service. Hosting costs depend on your Cloudflare plan, media processing, and usage; the guide covers budgets and backups.

Posts restricted to followers or mentioned people are not end-to-end encrypted. Anyone who has a media URL can access that file. Read the [privacy and compatibility limits](docs/implementation.md#explicit-release-limits) before sharing sensitive information.

## Help and contribute

- [Hosting, updates, backups, and troubleshooting](docs/operations.md)
- [Features and known compatibility limits](docs/implementation.md)
- [Local development and contributing](CONTRIBUTING.md)
- [Report a bug or request a feature](https://github.com/mitchell-johnson/Hyena/issues)
- [Report a security issue](SECURITY.md)

Hyena is licensed under [Apache-2.0](LICENSE). It began as a fork of [Wildebeest](https://github.com/cloudflare/wildebeest); the original attribution is preserved. See [third-party notices](THIRD_PARTY_NOTICES.md) for dependency licenses.
