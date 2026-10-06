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

## License

[MIT](LICENSE)

## Maintenance checks

Requires Node.js 22 or later. `npm test` runs without a local server or prebuilt assets;
`npm run ci-test` is an alias. CI checks both Linux and Windows.

`node scripts/copy-assets.mjs` rebuilds `.wrangler-assets/` from scratch, excluding
hidden files, local secrets, source maps, precompressed files and documentation assets.
Do not put manually maintained files in that generated directory. Symbolic links are
not copied, and linked destinations are rejected. Frontend bundle patches remain
necessary when refreshing the upstream frontend build.
