import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { SqliteD1 } from './sqliteD1.js';
import { LocalR2Storage } from './r2Storage.js';

if (typeof globalThis.caches === 'undefined') {
    globalThis.caches = {
        default: {
            async match() { return undefined; },
            async put() {},
            async delete() { return false; },
        },
    };
}

const selfOrigins = new Set();
const originalFetch = globalThis.fetch;
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');
const FUNCTIONS_DIR = resolve(ROOT_DIR, 'functions');
const DATA_DIR = resolve(ROOT_DIR, 'data');
const port = parseInt(process.env.PORT || '8080', 10);

globalThis.fetch = async function(input, init) {
    try {
        let urlStr;
        if (typeof input === 'string') urlStr = input;
        else if (input instanceof URL) urlStr = input.toString();
        else if (input instanceof Request) urlStr = input.url;

        if (urlStr) {
            const parsed = new URL(urlStr);
            const internalOrigin = `http://localhost:${port}`;
            if (parsed.origin !== internalOrigin && selfOrigins.has(parsed.origin)) {
                const newUrl = `${internalOrigin}${parsed.pathname}${parsed.search}`;
                if (input instanceof Request) {
                    return originalFetch(new Request(newUrl, input), init);
                }
                return originalFetch(newUrl, init);
            }
        }
    } catch (error) {
        if (!(error instanceof TypeError)) {
            console.error('Fetch interceptor error:', error.message);
        }
    }

    return originalFetch(input, init);
};

mkdirSync(DATA_DIR, { recursive: true });

const sqliteD1 = new SqliteD1(join(DATA_DIR, 'database.sqlite'));
const initSqlPath = join(ROOT_DIR, 'database', 'init.sql');
if (existsSync(initSqlPath)) {
    try {
        sqliteD1.exec(readFileSync(initSqlPath, 'utf8'));
    } catch (error) {
        console.log('Database init:', error.message);
    }
}

const migrationsDir = join(ROOT_DIR, 'database', 'migrations');
if (existsSync(migrationsDir)) {
    const migrations = readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort();
    for (const migration of migrations) {
        try {
            sqliteD1.exec(readFileSync(join(migrationsDir, migration), 'utf8'));
            console.log(`Migration ${migration}: OK`);
        } catch (error) {
            console.log(`Migration ${migration}: ${error.message}`);
        }
    }
}

const r2Storage = new LocalR2Storage(join(DATA_DIR, 'r2'));

function createEnv() {
    return {
        ...process.env,
        img_d1: sqliteD1,
        img_r2: r2Storage,
    };
}

function findFunctionFile(pathname) {
    const parts = pathname.split('/').filter(Boolean);

    if (parts.length > 0) {
        const exactFile = `${join(FUNCTIONS_DIR, ...parts)}.js`;
        if (existsSync(exactFile) && statSync(exactFile).isFile()) {
            return { file: exactFile, params: {} };
        }
    }

    if (parts.length > 0) {
        const indexFile = join(FUNCTIONS_DIR, ...parts, 'index.js');
        if (existsSync(indexFile) && statSync(indexFile).isFile()) {
            return { file: indexFile, params: {} };
        }
    }

    for (let i = parts.length - 1; i >= 0; i--) {
        const dirParts = parts.slice(0, i);
        const dirPath = join(FUNCTIONS_DIR, ...dirParts);
        if (existsSync(dirPath) && statSync(dirPath).isDirectory()) {
            const catchAllFile = join(dirPath, '[[path]].js');
            if (existsSync(catchAllFile) && statSync(catchAllFile).isFile()) {
                return { file: catchAllFile, params: { path: parts.slice(i) } };
            }
        }
    }

    return null;
}

const moduleCache = new Map();
async function importModule(filePath) {
    if (moduleCache.has(filePath)) {
        return moduleCache.get(filePath);
    }
    const mod = await import(pathToFileURL(filePath).href);
    moduleCache.set(filePath, mod);
    return mod;
}

async function findMiddlewares(pathname) {
    const parts = pathname.split('/').filter(Boolean);
    const middlewares = [];

    const rootMiddleware = join(FUNCTIONS_DIR, '_middleware.js');
    if (existsSync(rootMiddleware)) {
        const mod = await importModule(rootMiddleware);
        if (mod.onRequest) {
            middlewares.push(...(Array.isArray(mod.onRequest) ? mod.onRequest : [mod.onRequest]));
        }
    }

    for (let i = 1; i <= parts.length; i++) {
        const middlewareFile = join(FUNCTIONS_DIR, ...parts.slice(0, i), '_middleware.js');
        if (existsSync(middlewareFile) && statSync(middlewareFile).isFile()) {
            const mod = await importModule(middlewareFile);
            if (mod.onRequest) {
                middlewares.push(...(Array.isArray(mod.onRequest) ? mod.onRequest : [mod.onRequest]));
            }
        }
    }

    return middlewares;
}

async function executeChain(middlewares, handler, context) {
    const chain = [...middlewares, handler];
    let index = 0;

    context.next = async function() {
        if (index < chain.length) {
            const fn = chain[index++];
            return fn(context);
        }
        return new Response('Not Found', { status: 404 });
    };

    return context.next();
}

async function handleFunctionRequest(originalRequest, pathname) {
    const funcInfo = findFunctionFile(pathname);
    if (!funcInfo) return null;

    const requestUrl = new URL(originalRequest.url);
    const internalOrigin = `http://localhost:${port}`;
    if (requestUrl.origin !== internalOrigin) {
        selfOrigins.add(requestUrl.origin);
    }

    const mod = await importModule(funcInfo.file);
    const method = originalRequest.method.toUpperCase();
    const methodHandlerName = `onRequest${method.charAt(0)}${method.slice(1).toLowerCase()}`;

    let handler = null;
    if (typeof mod[methodHandlerName] === 'function') {
        handler = mod[methodHandlerName];
    } else if (typeof mod.onRequest === 'function') {
        handler = mod.onRequest;
    }

    if (!handler) {
        return new Response('Method not allowed', { status: 405 });
    }

    const middlewares = await findMiddlewares(pathname);
    const context = {
        request: originalRequest,
        env: createEnv(),
        params: funcInfo.params,
        data: {},
        waitUntil(promise) {
            Promise.resolve(promise).catch((error) => console.error('waitUntil error:', error));
        }
    };

    return executeChain(middlewares, handler, context);
}

const app = new Hono();

app.all('/functions/*', async (c) => {
    const pathname = c.req.path.replace(/^\/functions/, '') || '/';
    const response = await handleFunctionRequest(c.req.raw, pathname);
    return response || c.notFound();
});

app.all('*', async (c, next) => {
    const response = await handleFunctionRequest(c.req.raw, c.req.path);
    if (response) {
        return response;
    }
    return next();
});

app.use('*', serveStatic({ root: ROOT_DIR }));

serve({
    fetch: app.fetch,
    port
}, (info) => {
    console.log(`CloudFlare-ImgBed local server running at http://localhost:${info.port}`);
});
