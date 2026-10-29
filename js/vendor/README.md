# Local Document Preview Dependencies

These unmodified, fixed-version browser distributions are served from this
repository. They are loaded only when the corresponding preview is opened;
the application no longer fetches preview scripts from a CDN at runtime.
The four JavaScript assets total 1,158,936 bytes before HTTP compression.

| Asset | Version | Upstream Source | License Copy |
| --- | --- | --- | --- |
| `jszip-3.10.1.min.js` | 3.10.1 | https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js | `jszip-LICENSE.txt` (MIT or GPLv3; this project uses the MIT option) |
| `docx-preview-0.3.6.min.js` | 0.3.6 | https://cdn.jsdelivr.net/npm/docx-preview@0.3.6/dist/docx-preview.min.js | `docx-preview-LICENSE.txt` (Apache-2.0) |
| `xlsx-0.20.3.full.min.js` | 0.20.3 | https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js | `xlsx-LICENSE.txt` (Apache-2.0) |
| `marked-11.2.0.min.js` | 11.2.0 | https://cdn.jsdelivr.net/npm/marked@11.2.0/marked.min.js | `marked-LICENSE.txt` (MIT) |

SHA-256 checksums:

```text
acc7e41455a80765b5fd9c7ee1b8078a6d160bbbca455aeae854de65c947d59e  jszip-3.10.1.min.js
3573b8d993442316042e95c782338b503b2a7cd573d336db894b87799c9d3097  docx-preview-0.3.6.min.js
cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41  xlsx-0.20.3.full.min.js
e479cd780b6f4fe1494c6b4087505fa987f27f5ba6e0730a588e8398a07ee6e1  marked-11.2.0.min.js
```

Original license sources:

- https://cdn.jsdelivr.net/npm/jszip@3.10.1/LICENSE.markdown
- https://cdn.jsdelivr.net/npm/docx-preview@0.3.6/LICENSE
- https://cdn.sheetjs.com/xlsx-0.20.3/package/LICENSE
- https://cdn.jsdelivr.net/npm/marked@11.2.0/LICENSE.md

`test/document-preview-ui.test.js` verifies the versioned JavaScript hashes and
license files. Upgrades must replace the distribution and license together,
review upstream security notices, update these hashes and the test fixtures,
and rerun browser smoke tests. Do not replace SheetJS with the outdated npm
`xlsx` 0.18.5 distribution.

## Preview Boundaries

- PDF uses the browser's native iframe viewer and the backend's streaming and
  byte-range responses. Mobile browsers without an embedded viewer use the
  always-visible original-file open/download actions.
- DOCX/DOCM parsing stays local. A worker validates the ZIP before transferring
  the file into `document-preview.html`, an opaque-origin sandbox iframe. The
  frame cannot access the application DOM or make network requests; CSP permits
  only local renderer scripts, inline styling, and data/blob images. AltChunks,
  embedded fonts, macros, active attributes and navigable hyperlinks are disabled.
  Complex layout may differ from desktop Office.
- XLS/XLSX/XLSM/XLSB/ODS previews are parsed in a worker using cached values;
  formulas and macros are not evaluated. A preview shows at most 300 rows,
  50 columns, and 40 sheets, with cell text capped at 2,048 characters. Charts and
  complex formatting are not rendered.
- Local Office input is capped at 15 MiB. ZIP inspection rejects ZIP64,
  encryption, traversal/duplicate paths, more than 2,000 entries, more than
  16 MiB per expanded entry, more than 40 MiB total expansion, and extreme
  compression ratios. Actual expanded bytes and total XML markup are checked
  in the worker rather than trusting archive metadata. Parsing has a 15-second
  deadline; file headers and streamed content each have a 30-second deadline.
  These are browser resource guards, not a general-purpose malware scanner.
- Legacy DOC and PPT/PPTX/PPTM use Microsoft Office Online only after explicit
  user consent and a successful anonymous HEAD check. Temporary URLs, URLs with
  credentials/query secrets, HTTP, and private-network addresses are never sent.
  Authenticated/private presentations and legacy Word files must be downloaded
  or rendered through a separately deployed trusted conversion service.
  Microsoft's availability and format/size limits still apply.
- Markdown/text reads are capped at 2 MiB. Marked output is sanitized using an
  inert-template tag/URL allowlist; active markup and remote images are removed,
  and external links receive `noopener noreferrer`. Parser-load failure falls
  back to escaped plain text. This intentional image restriction prevents
  previewing an untrusted document from disclosing a user's address or cookies
  to remote image trackers.

## Validation

Run `node node_modules/mocha/bin/mocha.js test/document-preview-ui.test.js`.
Tests cover MIME/name detection, opaque file IDs, cookie-only authorization,
explicit Office sharing, bounded streams, real XLSX parsing, ZIP path/expansion
limits, forged archive lengths, and pinned dependencies.

Chromium smoke tests additionally exercised authenticated DOCX/XLSX loading,
worksheet switching, malicious DOCX symbol/HTML/link payloads, Markdown
JavaScript links and image trackers, a 375x812 mobile viewport, and modal cleanup.
No external document requests, JavaScript dialogs, or page errors occurred.
Firefox/Safari and Microsoft's external service were not live-tested.
