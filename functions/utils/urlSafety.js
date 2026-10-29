function blockedIpv4(parts) {
    if (parts.length !== 4 || parts.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return true;
    const [a, b, c] = parts;
    return a === 0 || a === 10 || a === 127 || a >= 224
        || (a === 100 && b >= 64 && b <= 127)
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
        || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
        || (a === 203 && b === 0 && c === 113);
}

function ipv6Words(host) {
    let value = host;
    if (value.includes('.')) {
        const lastColon = value.lastIndexOf(':');
        const parts = value.slice(lastColon + 1).split('.').map(Number);
        if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
        value = value.slice(0, lastColon + 1)
            + ((parts[0] << 8) | parts[1]).toString(16) + ':' + ((parts[2] << 8) | parts[3]).toString(16);
    }
    const halves = value.split('::');
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const padding = 8 - left.length - right.length;
    if ((halves.length === 1 && padding !== 0) || (halves.length === 2 && padding < 1)) return null;
    const words = [...left, ...Array(padding).fill('0'), ...right];
    return words.length === 8 && words.every(word => /^[0-9a-f]{1,4}$/.test(word))
        ? words.map(word => parseInt(word, 16)) : null;
}

/** Reject literal private, loopback, link-local and reserved destinations. DNS is not resolved here. */
export function isBlockedHost(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!host) return true;
    if (host.includes(':')) {
        const words = ipv6Words(host);
        if (!words) return true;
        // URL normalizes dotted IPv4-mapped IPv6 into hexadecimal hextets.
        if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff) {
            return blockedIpv4([words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255]);
        }
        return (words[0] & 0xe000) !== 0x2000 || words[0] === 0x2002
            || (words[0] === 0x2001 && (words[1] < 0x200 || words[1] === 0xdb8));
    }
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return blockedIpv4(host.split('.').map(Number));
    if (!host.includes('.') || host === 'metadata.google.internal' || host === 'metadata.goog'
        || /(?:^|\.)(?:localhost|local|internal|localdomain)$/.test(host)) return true;
    return !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

/** Exact hostnames only: no wildcard, path, credentials or arbitrary port. */
export function parseAllowedHosts(value) {
    const entries = Array.isArray(value) ? value : String(value || '').split(/[\s,]+/);
    const hosts = new Set();
    for (const entry of entries.filter(Boolean)) {
        try {
            const parsed = new URL(`https://${entry}`);
            if (parsed.pathname === '/' && !parsed.search && !parsed.hash && !parsed.port
                && !parsed.username && !parsed.password && !isBlockedHost(parsed.hostname)) {
                hosts.add(parsed.hostname.toLowerCase().replace(/\.$/, ''));
            }
        } catch { /* Invalid host configuration is ignored, never treated as a wildcard. */ }
    }
    return hosts;
}

/**
 * @param {string} rawUrl
 * @param {import('./contracts.js').UrlValidationOptions} [options]
 * @returns {import('./contracts.js').UrlValidationResult}
 */
export function validateHttpUrl(rawUrl, { allowedHosts, requireAllowlist = false } = {}) {
    let parsed;
    try { parsed = new URL(rawUrl); }
    catch { return { ok: false, error: 'Invalid URL' }; }
    if (!['http:', 'https:'].includes(parsed.protocol)) return { ok: false, error: 'Only http/https URLs are allowed' };
    if (parsed.username || parsed.password || (parsed.port && !['80', '443'].includes(parsed.port))) {
        return { ok: false, error: 'URL credentials and non-standard ports are not allowed' };
    }
    if (isBlockedHost(parsed.hostname)) return { ok: false, error: 'Target host is not allowed' };
    const hosts = parseAllowedHosts(allowedHosts);
    if ((requireAllowlist || String(allowedHosts || '').trim())
        && !hosts.has(parsed.hostname.toLowerCase().replace(/\.$/, ''))) {
        return { ok: false, error: 'Target host is not in the configured allowlist' };
    }
    parsed.hash = '';
    return { ok: true, parsed };
}
