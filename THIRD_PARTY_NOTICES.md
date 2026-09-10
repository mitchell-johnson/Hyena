# Third-party notices

Hyena began as a fork of [Cloudflare Wildebeest](https://github.com/cloudflare/wildebeest). Its original copyright and Apache-2.0 attribution are preserved in [LICENSE](LICENSE) and repository history. The legacy application has been removed from the current source tree.

Current runtime dependencies are pinned in `package-lock.json`. The [runtime dependency notices](docs/third-party-notices.md) list their versions, licenses, and source packages. Regenerate that inventory with `node scripts/dependency-notices.mjs` after changing dependencies.

Package license files are included in their npm distributions. Runtime packages are used without source modifications; dependency licenses remain applicable. Synthetic media fixtures are documented in [tests/fixtures/README.md](tests/fixtures/README.md).
