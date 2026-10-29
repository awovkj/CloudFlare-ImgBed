# CloudFlare ImgBed

[简体中文](README.md) | [Documentation](https://cfbed.sanyue.de/en) | [Demo](https://cfbed.1314883.xyz/)

An open-source file hosting service for Cloudflare Workers. It supports Telegram, Discord, Cloudflare R2, S3, Hugging Face, and WebDAV, with upload management, directory browsing, authentication, temporary links, random images, and music, video, and chat pages.

![Interface preview](img/海报.png)

## Development And Deployment

```bash
npm ci
npm start
```

Common commands:

| Command | Purpose |
| --- | --- |
| `npm test` | Run tests and verify the generated Worker routes |
| `npm run build:worker` | Run a Workers deployment dry run |
| `npm run worker:dev` | Start local development on port `8788` |
| `npm run worker:deploy` | Deploy the production environment |
| `npm run worker:deploy:dev` | Deploy the `dev` environment |
| `npm run worker:secret -- <NAME>` | Store a Worker secret |

The Worker entry point, static assets, and bindings are configured in [`wrangler.toml`](wrangler.toml). Before the first deployment, verify the KV, R2, D1, and Durable Object settings for your environment.

See the [documentation](https://cfbed.sanyue.de/en) for full deployment instructions, features, release notes, and troubleshooting.

## Project Structure

```text
functions/   Business handlers using the Pages Functions interface
src/         Worker entry point, route adapter, and Durable Object
js/ css/     Built frontend assets and enhancement scripts
scripts/     Deployment asset preparation and frontend patch scripts
database/    D1 initialization and migrations
test/        Automated tests
```

The frontend source is maintained in [MarSeventh/Sanyue-ImgHub](https://github.com/MarSeventh/Sanyue-ImgHub).

## Document Preview and Audit

PDF delivery now supports streaming byte ranges, metadata-only HEAD and validators.
DOCX and Excel preview locally with lazy, sandboxed parsers; private files are not
automatically shared with Microsoft. Legacy Word/presentations require explicit
public-file consent or a separately deployed trusted converter.

Uploads have no application size, extension or MIME-type caps; obsolete
UPLOAD_MAX_* and UPLOAD_ALLOWED_* settings are ignored. Cloudflare and provider
limits still apply. Chunk requests declare fileSize/chunkSize for integrity,
not quotas. Hard-refresh older cached upload bundles after deploying.
See `.dev.vars.example` for exact CORS origins and the trusted-host proxy allowlist. Configure strong administrator
credentials before exposing this application's intentionally open setup mode.

The [audit report](docs/audit-upgrade-2026-10.md) records fixes, validation,
conditional cleanup recommendations and remaining architecture work. `npm test`
includes incremental typechecking; use Node >=22.12.0. No project-file deletion,
Git history rewriting or production deployment was performed.

Deletion now shares one configuration-aware implementation across management,
batch and chat. Provider failures preserve records; Discord part retries are
idempotent and WebDAV/folder failures are not acknowledged as completed deletes.
Upload cleanup uses only a validated stored session count, preserves retry state
and cannot overlap a live merge in the same DO. Cleanup candidates still require confirmation.

HF multipart uploads complete against a server-issued descriptor before LFS commit
or final metadata publication. Recovery receipts prevent blind completion replay
after uncertain outcomes. Commit/complete JSON has a stream-counted 2 MiB schema
budget; initialization stays at 64 KiB. Neither is a file quota. The current suite
has 506 passing tests, with incremental typechecking and deployment dry-run checks.

Local parser limits protect preview, not file acceptance. Remote URL import still
has a 25 MiB/10-second safety boundary; External redirect documents require opening
the original URL instead of fetch-based in-app preview. The DOCX DOM render timeout
is not a hard, preemptive CPU limit.

## License

[MIT](LICENSE)

## Maintenance checks

Requires Node.js >=22.12.0. `npm test` runs without a local server or prebuilt assets;
`npm run ci-test` is an alias. CI checks both Linux and Windows.

`node scripts/copy-assets.mjs` rebuilds `.wrangler-assets/` from scratch, excluding
hidden files, local secrets, source maps, precompressed files and documentation assets.
Do not put manually maintained files in that generated directory. Symbolic links are
not copied, and linked destinations are rejected. Frontend bundle patches remain
necessary when refreshing the upstream frontend build.
