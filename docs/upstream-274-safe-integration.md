# Upstream 2.7.4 Safe Integration Notes

This fork selectively integrates requested CloudFlare-ImgBed 2.7.4 improvements while preserving music, video, chat, Worker Durable Object, and Telegram lane customizations.

Integrated areas:

- HuggingFace multipart completion proxy at `/upload/huggingface/completeMultipart`.
- HuggingFace direct upload URL rewriting for Cloudflare Worker deployments.
- Upload success `publicUrl` when `urlPrefix` is configured.
- Empty MIME fallback to `application/octet-stream`.
- WebDAV credential resolution and read/delete/move/rename behavior aligned with 2.7.4.
- Current channel config credential resolution for S3/R2, Telegram, Discord, HuggingFace, and WebDAV.
- Sensitive metadata stripping and dynamic management display enrichment.
- Auth/session 503 failure handling and 1-3650 day session max-age normalization.

Verification commands:

```bash
npm test
npm run generate:worker-routes
npm run build:frontend-dist
npm run build:worker
```
