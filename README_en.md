# CloudFlare ImgBed

[简体中文](README.md) | [Documentation](https://cfbed.sanyue.de/en) | [Demo](https://cfbed.1314883.xyz/)

An open-source file hosting service for Cloudflare Workers. It supports Telegram, Discord, Cloudflare R2, S3, Hugging Face, and WebDAV, with upload management, directory browsing, authentication, temporary links, random images, and music, video, and chat pages.

![Interface preview](static/readme/海报.png)

## Development And Deployment

```bash
npm install
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
