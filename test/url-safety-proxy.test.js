import assert from 'node:assert/strict';
import { isBlockedHost, parseAllowedHosts, validateHttpUrl } from '../functions/utils/urlSafety.js';
import { createBoundedProxyBody, onRequest as proxy } from '../functions/api/fetchRes.js';
import { createSession } from '../functions/utils/auth/sessionManager.js';

const encoder = new TextEncoder();
const tick = () => new Promise(resolve => setImmediate(resolve));

function makeEnv(overrides = {}) {
    const entries = new Map();
    return { ...overrides, img_url: {
        async get(key) { return entries.get(key) ?? null; },
        async put(key, value) { entries.set(key, value); },
        async delete(key) { entries.delete(key); },
        async list() { return { list_complete: true, keys: [] }; },
    } };
}

function proxyContext(env, target = 'https://trusted.example/file.pdf', headers = {}, method = 'POST') {
    return { env, request: new Request('https://img.example/api/fetchRes', {
        method, headers: { 'Content-Type': 'application/json', ...headers },
        body: method === 'POST' ? JSON.stringify({ url: target }) : undefined,
    }) };
}

function cancellableBody(bytes = encoder.encode('redirect')) {
    const state = { cancelled: false, reason: undefined };
    const body = new ReadableStream({
        start(controller) { controller.enqueue(bytes); },
        cancel(reason) { state.cancelled = true; state.reason = reason; },
    });
    return { body, state };
}

describe('SSRF URL canonicalization and exact host policies', () => {
    it('blocks non-canonical loopback IPv4 spellings after URL normalization', () => {
        for (const host of ['127.0.0.1', '127.1', '2130706433', '0x7f000001', '0x7f.0.0.1', '0177.0.0.1', '%31%32%37.0.0.1']) {
            assert.equal(validateHttpUrl(`http://${host}/secret`).ok, false, host);
        }
    });

    it('blocks private, carrier-grade, metadata, benchmark, multicast and reserved IPv4 ranges', () => {
        for (const host of ['0.0.0.0', '10.1.2.3', '172.16.1.2', '172.31.255.255', '192.168.1.2',
            '169.254.169.254', '100.64.0.1', '100.127.255.254', '198.18.1.2', '198.19.255.1',
            '192.0.2.1', '198.51.100.2', '203.0.113.3', '224.0.0.1', '255.255.255.255']) {
            assert.equal(isBlockedHost(host), true, host);
        }
        for (const host of ['8.8.8.8', '172.15.255.255', '172.32.0.1', '100.63.255.255']) assert.equal(isBlockedHost(host), false, host);
    });

    it('blocks mapped/compatible IPv4, 6to4, NAT64 and non-global IPv6 literals', () => {
        for (const host of ['[::1]', '[::]', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[0:0:0:0:0:ffff:7f00:1]',
            '[::ffff:10.0.0.1]', '[::127.0.0.1]', '[2002:7f00:1::]', '[64:ff9b::7f00:1]',
            '[fc00::1]', '[fd00::1]', '[fe80::1]', '[ff02::1]', '[2001:db8::1]', '[2001::1]']) {
            assert.equal(validateHttpUrl(`https://${host}/secret`).ok, false, host);
        }
        assert.equal(validateHttpUrl('https://[2606:4700:4700::1111]/').ok, true);
        assert.equal(validateHttpUrl('https://[2001:4860:4860::8888]/').ok, true);
    });

    it('does not accidentally apply IPv6 fc/fd prefixes to public DNS names', () => {
        for (const host of ['fcdn.example', 'fdpublic.example', 'example.com', 'EXAMPLE.COM.']) {
            assert.equal(isBlockedHost(host), false, host);
        }
        for (const host of ['localhost', 'localhost.', 'a.localhost', 'service.local', 'service.internal',
            'metadata.google.internal', 'metadata.goog', 'single-label', 'bad..example']) assert.equal(isBlockedHost(host), true, host);
    });

    it('rejects credentials, non-HTTP schemes, and arbitrary ports', () => {
        for (const url of ['https://user:password@trusted.example/file', 'https://trusted.example:8443/',
            'http://trusted.example:8080/', 'file:///etc/passwd', 'ftp://trusted.example/', 'javascript:alert(1)', 'data:text/html,test']) {
            assert.equal(validateHttpUrl(url).ok, false, url);
        }
    });

    it('requires exact administrator-configured hosts and strips URL fragments', () => {
        const options = { allowedHosts: 'trusted.example, second.example', requireAllowlist: true };
        const result = validateHttpUrl('https://TRUSTED.example/file#not-forwarded', options);
        assert.equal(result.ok, true);
        assert.equal(result.parsed.href, 'https://trusted.example/file');
        for (const url of ['https://trusted.example.attacker.example/', 'https://sub.trusted.example/', 'https://outside.example/']) {
            assert.equal(validateHttpUrl(url, options).ok, false);
        }
        assert.equal(validateHttpUrl('https://trusted.example/', { requireAllowlist: true }).ok, false);
    });

    it('never broadens host policy through wildcard, URL, path, private, or credential entries', () => {
        const hosts = parseAllowedHosts('trusted.example, *.trusted.example, https://other.example, trusted.example/path, user:pass@other.example, 127.0.0.1, other.example:8443');
        assert.deepEqual([...hosts], ['trusted.example']);
        assert.equal(validateHttpUrl('https://trusted.example/', { allowedHosts: '*' }).ok, false);
    });
});

describe('authenticated bounded HTTP resource proxy', () => {
    let previousFetch;
    beforeEach(() => { previousFetch = globalThis.fetch; });
    afterEach(() => { globalThis.fetch = previousFetch; });

    it('permits only POST and preflight without issuing network requests', async () => {
        let calls = 0;
        globalThis.fetch = async () => { calls++; throw new Error('must not fetch'); };
        const env = makeEnv({ FETCH_ALLOWED_HOSTS: 'trusted.example' });
        for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
            const response = await proxy(proxyContext(env, undefined, {}, method));
            assert.equal(response.status, 405);
            assert.match(response.headers.get('Allow'), /POST/);
        }
        assert.equal((await proxy(proxyContext(env, undefined, {}, 'OPTIONS'))).status, 204);
        assert.equal(calls, 0);
    });

    it('requires configured user authentication before proxying', async () => {
        let calls = 0;
        globalThis.fetch = async () => { calls++; return new Response('unexpected'); };
        const response = await proxy(proxyContext(makeEnv({ AUTH_CODE: 'test-password', FETCH_ALLOWED_HOSTS: 'trusted.example' })));
        assert.equal(response.status, 401);
        assert.equal(calls, 0);
    });

    it('requires a trusted allowlist even when uploads are public', async () => {
        let calls = 0;
        globalThis.fetch = async () => { calls++; return new Response('unexpected'); };
        assert.equal((await proxy(proxyContext(makeEnv()))).status, 400);
        assert.equal((await proxy(proxyContext(makeEnv({ FETCH_ALLOWED_HOSTS: 'trusted.example' }), 'https://outside.example/file'))).status, 400);
        assert.equal(calls, 0);
    });

    it('uses a real user session but forwards no browser credentials or upstream cookies', async () => {
        const env = makeEnv({ AUTH_CODE: 'test-password', FETCH_ALLOWED_HOSTS: 'trusted.example' });
        const { cookie } = await createSession(env, 'user');
        let options;
        globalThis.fetch = async (url, supplied) => {
            assert.equal(url, 'https://trusted.example/file.pdf');
            options = supplied;
            return new Response('document', { headers: { 'Content-Type': 'application/pdf', 'Set-Cookie': 'upstream=private', Server: 'private-server' } });
        };
        const response = await proxy(proxyContext(env, undefined, { Cookie: cookie.split(';')[0], Authorization: 'Bearer browser-secret' }));
        assert.equal(response.status, 200);
        assert.equal(await response.text(), 'document');
        assert.equal(options.headers, undefined);
        assert.equal(options.redirect, 'manual');
        assert.ok(options.signal instanceof AbortSignal);
        assert.equal(response.headers.get('Set-Cookie'), null);
        assert.equal(response.headers.get('Server'), null);
        assert.equal(response.headers.get('Content-Disposition'), 'attachment');
        assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
    });

    it('revalidates relative and absolute redirects and cancels intermediate bodies', async () => {
        const env = makeEnv({ FETCH_ALLOWED_HOSTS: 'trusted.example, second.example' });
        const calls = [];
        const intermediate = [];
        globalThis.fetch = async url => {
            calls.push(url);
            if (calls.length < 3) {
                const state = cancellableBody();
                intermediate.push(state.state);
                return new Response(state.body, { status: 302, headers: { Location: calls.length === 1 ? 'https://second.example/step' : '/final#ignored' } });
            }
            return new Response('final document');
        };
        const response = await proxy(proxyContext(env));
        assert.equal(response.status, 200);
        assert.equal(await response.text(), 'final document');
        assert.deepEqual(calls, ['https://trusted.example/file.pdf', 'https://second.example/step', 'https://second.example/final']);
        assert.equal(intermediate.every(state => state.cancelled), true);
    });

    for (const location of ['http://[::ffff:7f00:1]/metadata', 'https://outside.example/file',
        'https://user:password@trusted.example/file', 'https://trusted.example:8443/file', 'javascript:alert(1)']) {
        it(`rejects a redirect hop before fetching ${location}`, async () => {
            const env = makeEnv({ FETCH_ALLOWED_HOSTS: 'trusted.example' });
            const upstream = cancellableBody();
            let calls = 0;
            globalThis.fetch = async () => { calls++; return new Response(upstream.body, { status: 302, headers: { Location: location } }); };
            const response = await proxy(proxyContext(env));
            assert.equal(response.status, 400);
            assert.equal(calls, 1);
            assert.equal(upstream.state.cancelled, true);
        });
    }

    it('caps redirect loops and cancels every discarded body', async () => {
        const env = makeEnv({ FETCH_ALLOWED_HOSTS: 'trusted.example' });
        const states = [];
        globalThis.fetch = async () => { const upstream = cancellableBody(); states.push(upstream.state); return new Response(upstream.body, { status: 302, headers: { Location: '/loop' } }); };
        const response = await proxy(proxyContext(env));
        assert.equal(response.status, 502);
        assert.equal(states.length, 4);
        assert.equal(states.every(state => state.cancelled), true);
    });

    it('rejects an oversized declared response and aborts its upstream fetch', async () => {
        const env = makeEnv({ FETCH_ALLOWED_HOSTS: 'trusted.example' });
        const upstream = cancellableBody();
        let signal;
        globalThis.fetch = async (url, options) => { signal = options.signal; return new Response(upstream.body, { headers: { 'Content-Length': String(25 * 1024 * 1024 + 1) } }); };
        const response = await proxy(proxyContext(env));
        assert.equal(response.status, 502);
        assert.equal(upstream.state.cancelled, true);
        assert.equal(signal.aborted, true);
    });

    it('counts actual response bytes despite a dishonest smaller Content-Length', async () => {
        const env = makeEnv({ FETCH_ALLOWED_HOSTS: 'trusted.example' });
        const upstream = cancellableBody(new Uint8Array(25 * 1024 * 1024 + 1));
        let signal;
        globalThis.fetch = async (url, options) => { signal = options.signal; return new Response(upstream.body, { headers: { 'Content-Length': '1' } }); };
        const response = await proxy(proxyContext(env));
        await assert.rejects(() => response.arrayBuffer(), /too large/i);
        await tick();
        assert.equal(upstream.state.cancelled, true);
        assert.equal(signal.aborted, true);
    });

    it('does not expose upstream exception details', async () => {
        globalThis.fetch = async () => { throw new Error('private-server credential=private-value'); };
        const response = await proxy(proxyContext(makeEnv({ FETCH_ALLOWED_HOSTS: 'trusted.example' })));
        assert.equal(response.status, 502);
        assert.doesNotMatch(await response.text(), /private-server|private-value/);
    });
});

describe('proxy body lifetime, timeout and cancellation', () => {
    it('keeps the timeout active after headers until a stalled body is cancelled', async () => {
        let cancelled = false;
        const upstream = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } });
        const abort = new AbortController();
        const timeout = setTimeout(() => abort.abort(new Error('body timeout')), 10);
        const response = new Response(createBoundedProxyBody(upstream, 3, abort, timeout));
        await assert.rejects(() => response.text(), /body timeout/);
        assert.equal(cancelled, true);
        assert.equal(abort.signal.aborted, true);
    });

    it('propagates downstream cancellation to the upstream reader and AbortSignal', async () => {
        const upstream = cancellableBody();
        const abort = new AbortController();
        const timeout = setTimeout(() => abort.abort(new Error('must be cleared')), 1000);
        const body = createBoundedProxyBody(upstream.body, 100, abort, timeout);
        await body.cancel('viewer closed');
        assert.equal(upstream.state.cancelled, true);
        assert.equal(upstream.state.reason, 'viewer closed');
        assert.equal(abort.signal.aborted, true);
    });

    it('clears the deadline after EOF rather than aborting a completed response later', async () => {
        const abort = new AbortController();
        const timeout = setTimeout(() => abort.abort(new Error('late abort')), 10);
        const upstream = new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('abc')); controller.close(); } });
        const response = new Response(createBoundedProxyBody(upstream, 3, abort, timeout));
        assert.equal(await response.text(), 'abc');
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(abort.signal.aborted, false);
    });

    it('handles an already-aborted fetch without leaking its body or timer', async () => {
        const upstream = cancellableBody();
        const abort = new AbortController();
        abort.abort(new Error('already aborted'));
        const timeout = setTimeout(() => {}, 1000);
        const response = new Response(createBoundedProxyBody(upstream.body, 100, abort, timeout));
        await assert.rejects(() => response.text(), /already aborted/);
        assert.equal(upstream.state.cancelled, true);
    });
});
