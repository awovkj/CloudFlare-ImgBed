// Canonical file MIME inference shared by upload metadata and file responses.
const TEXT_PLAIN = 'text/plain; charset=utf-8';
const EXT_MIME_MAP = {
    // Documents
    pdf: 'application/pdf',
    doc: 'application/msword',
    dot: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    dotx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
    docm: 'application/vnd.ms-word.document.macroenabled.12',
    dotm: 'application/vnd.ms-word.template.macroenabled.12',
    xls: 'application/vnd.ms-excel',
    xlt: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xltx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
    xlsm: 'application/vnd.ms-excel.sheet.macroenabled.12',
    xltm: 'application/vnd.ms-excel.template.macroenabled.12',
    xlsb: 'application/vnd.ms-excel.sheet.binary.macroenabled.12',
    ppt: 'application/vnd.ms-powerpoint',
    pot: 'application/vnd.ms-powerpoint',
    pps: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    potx: 'application/vnd.openxmlformats-officedocument.presentationml.template',
    ppsx: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
    pptm: 'application/vnd.ms-powerpoint.presentation.macroenabled.12',
    potm: 'application/vnd.ms-powerpoint.template.macroenabled.12',
    ppsm: 'application/vnd.ms-powerpoint.slideshow.macroenabled.12',
    rtf: 'application/rtf',
    odt: 'application/vnd.oasis.opendocument.text',
    ods: 'application/vnd.oasis.opendocument.spreadsheet',
    odp: 'application/vnd.oasis.opendocument.presentation',
    // EPUB is a ZIP container and is downloaded rather than natively rendered.
    epub: 'application/epub+zip',

    // Text/structured data; text/plain keeps Markdown readable in a browser.
    txt: TEXT_PLAIN, text: TEXT_PLAIN, log: TEXT_PLAIN, md: TEXT_PLAIN,
    markdown: TEXT_PLAIN, mdown: TEXT_PLAIN, rst: TEXT_PLAIN, srt: TEXT_PLAIN,
    vtt: 'text/vtt; charset=utf-8',
    json: 'application/json; charset=utf-8',
    jsonl: TEXT_PLAIN, ndjson: TEXT_PLAIN, json5: TEXT_PLAIN,
    // File delivery adds a sandbox CSP to XML/SVG.
    xml: 'application/xml; charset=utf-8',
    yml: TEXT_PLAIN, yaml: TEXT_PLAIN, toml: TEXT_PLAIN, ini: TEXT_PLAIN,
    conf: TEXT_PLAIN, cfg: TEXT_PLAIN, env: TEXT_PLAIN, properties: TEXT_PLAIN,
    csv: 'text/csv; charset=utf-8',
    tsv: 'text/tab-separated-values; charset=utf-8',

    // Source code must not be executable as a same-origin script or stylesheet.
    js: TEXT_PLAIN, mjs: TEXT_PLAIN, cjs: TEXT_PLAIN, jsx: TEXT_PLAIN,
    tsx: TEXT_PLAIN, vue: TEXT_PLAIN, css: TEXT_PLAIN, scss: TEXT_PLAIN,
    less: TEXT_PLAIN, sass: TEXT_PLAIN, py: TEXT_PLAIN, java: TEXT_PLAIN,
    kt: TEXT_PLAIN, c: TEXT_PLAIN, h: TEXT_PLAIN, cpp: TEXT_PLAIN,
    hpp: TEXT_PLAIN, cc: TEXT_PLAIN, cs: TEXT_PLAIN, go: TEXT_PLAIN,
    rs: TEXT_PLAIN, rb: TEXT_PLAIN, php: TEXT_PLAIN, pl: TEXT_PLAIN,
    lua: TEXT_PLAIN, swift: TEXT_PLAIN, sh: TEXT_PLAIN, bash: TEXT_PLAIN,
    zsh: TEXT_PLAIN, bat: TEXT_PLAIN, cmd: TEXT_PLAIN, ps1: TEXT_PLAIN,
    sql: TEXT_PLAIN, dockerfile: TEXT_PLAIN, gradle: TEXT_PLAIN,
    patch: TEXT_PLAIN, diff: TEXT_PLAIN,

    // Active pages are forced to attachment by file delivery.
    html: 'text/html; charset=utf-8',
    htm: 'text/html; charset=utf-8',
    xhtml: 'application/xhtml+xml; charset=utf-8',

    // Images
    png: 'image/png', apng: 'image/apng', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    jpe: 'image/jpeg', jfif: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    bmp: 'image/bmp', ico: 'image/x-icon', cur: 'image/x-icon',
    avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
    tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml',

    // Audio
    mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac',
    m4a: 'audio/mp4', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
    wma: 'audio/x-ms-wma', mid: 'audio/midi', midi: 'audio/midi',
    amr: 'audio/amr', ape: 'audio/x-ape',

    // Video; .ts is deliberately ambiguous (TypeScript versus MPEG-TS).
    mp4: 'video/mp4', m4v: 'video/x-m4v', webm: 'video/webm', ogv: 'video/ogg',
    mov: 'video/quicktime', avi: 'video/x-msvideo', mkv: 'video/x-matroska',
    flv: 'video/x-flv', wmv: 'video/x-ms-wmv', mpg: 'video/mpeg',
    mpeg: 'video/mpeg', '3gp': 'video/3gpp', mts: 'video/mp2t', m2ts: 'video/mp2t',

    // Archives
    zip: 'application/zip', rar: 'application/x-rar-compressed',
    '7z': 'application/x-7z-compressed', tar: 'application/x-tar',
    gz: 'application/gzip', tgz: 'application/gzip',
    bz2: 'application/x-bzip2', xz: 'application/x-xz',
    zst: 'application/zstd',

    // Binary installers/images
    exe: 'application/octet-stream', msi: 'application/octet-stream',
    apk: 'application/vnd.android.package-archive',
    dmg: 'application/octet-stream', iso: 'application/octet-stream',
    deb: 'application/octet-stream', rpm: 'application/octet-stream',
    jar: 'application/java-archive', bin: 'application/octet-stream',

    // Fonts
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
    eot: 'application/vnd.ms-fontobject',
};

// Browser/upstream values that do not identify an actual MIME type.
const GENERIC_MIME_TYPES = new Set([
    '', 'application/octet-stream', 'binary/octet-stream', 'application/binary',
    'application/download', 'application/force-download', 'application/x-download',
    'application/unknown', '*/*', 'unknown', 'null', 'undefined',
]);

function extractExtension(name) {
    if (!name) return '';
    const base = String(name).split('/').pop().split('\\').pop();
    const dot = base.lastIndexOf('.');
    if (dot <= 0 || dot === base.length - 1) return '';
    return base.slice(dot + 1).toLowerCase();
}

/**
 * Canonical extension first, then a valid stored MIME, then octet-stream.
 *
 * @param {string} fileName - metadata.FileName
 * @param {unknown} storedType - metadata.FileType
 * @param {string} [fallbackName] - File ID when the name lacks an extension.
 * @returns {string} A validated Content-Type header value.
 */
export function resolveContentType(fileName, storedType, fallbackName = '') {
    const ext = extractExtension(fileName) || extractExtension(fallbackName);
    const mapped = ext ? EXT_MIME_MAP[ext] : undefined;
    if (mapped) return mapped;

    const stored = typeof storedType === 'string' ? storedType.trim() : '';
    if (stored && /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?: *;[^\x00-\x1f\x7f]*)?$/.test(stored)
        && !GENERIC_MIME_TYPES.has(normalizeMime(stored))) return stored;

    return 'application/octet-stream';
}

export function normalizeMime(fileType) {
    if (!fileType) return '';
    return fileType.split(';')[0].trim().toLowerCase();
}
