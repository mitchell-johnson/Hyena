# Runtime dependencies

Hyena retains the original Wildebeest Apache-2.0 license and notices. New runtime dependencies are unmodified packages resolved by `package-lock.json`:

| Package | License | Source |
| --- | --- | --- |
| Hono | MIT | https://github.com/honojs/hono |
| @fastify/busboy | MIT | https://github.com/fastify/busboy |
| @noble/hashes | MIT | https://github.com/paulmillr/noble-hashes |
| Mediabunny | MPL-2.0 | https://github.com/Vanilagy/mediabunny |

Full package license files are included in their npm distributions. Mediabunny is used for bounded metadata parsing; no custom changes are made to its source. Development dependencies retain their respective package licenses. Synthetic media fixtures were generated for this project as described in `tests/fixtures/README.md`.
