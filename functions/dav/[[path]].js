import { fetchSecurityConfig, fetchOthersConfig } from "../utils/sysConfig";

export async function onRequest(context) {
    const { request, env } = context;

    const authResponse = await checkAuth(request, env);
    if (authResponse) return authResponse;

    switch (request.method) {
        case 'OPTIONS': return handleOptions(request);
        case 'PROPFIND': return handlePropfind(request, env);
        case 'PUT': return handlePut(request, env);
        case 'DELETE': return handleDelete(request, env);
        case 'GET': return handleGet(request, env);
        case 'HEAD': return handleHead(request, env);
        case 'MKCOL': return handleMkcol(request, env);
        case 'COPY': return handleCopy(request, env);
        case 'MOVE': return handleMove(request, env);
        case 'LOCK': return handleLock(request, env);
        case 'UNLOCK': return handleUnlock(request, env);
        case 'PROPPATCH': return handleProppatch(request, env);
        default: return new Response('Method Not Allowed', { status: 405 });
    }
}

async function getApiHeaders(env) {
    const securityConfig = await fetchSecurityConfig(env);
    const adminUsername = securityConfig.auth.admin.adminUsername;
    const adminPassword = securityConfig.auth.admin.adminPassword;
    const authCode = securityConfig.auth.user.authCode;

    let credentials = btoa('unset:unset');
    if (adminUsername && adminPassword) {
        credentials = btoa(`${adminUsername}:${adminPassword}`);
    }

    return {
        'Authorization': `Basic ${credentials}`,
        'authCode': authCode || ''
    };
}

async function checkAuth(request, env) {
    const othersConfig = await fetchOthersConfig(env);

    const enabled = othersConfig.webDAV?.enabled;
    if (!enabled) return new Response('WebDAV is disabled', { status: 403 });

    const davUser = othersConfig.webDAV?.username;
    const davPass = othersConfig.webDAV?.password;
    if (!davUser || !davPass) return null;

    const authHeader = request.headers.get('Authorization');
    if (!authHeader) {
        return new Response('Unauthorized', {
            status: 401,
            headers: {
                'WWW-Authenticate': 'Basic realm="WebDAV"',
                'Content-Type': 'text/plain',
            },
        });
    }

    const [scheme, encoded] = authHeader.split(' ');
    if (scheme !== 'Basic' || !encoded) {
        return new Response('Bad Request', { status: 400 });
    }

    const decoded = atob(encoded);
    const colonIndex = decoded.indexOf(':');
    if (colonIndex === -1) {
        return new Response('Bad Request', { status: 400 });
    }

    const user = decoded.substring(0, colonIndex);
    const pass = decoded.substring(colonIndex + 1);

    if (user !== davUser || pass !== davPass) {
        return new Response('Forbidden', { status: 403 });
    }

    return null;
}

function getNowRFC1123() {
    return new Date().toUTCString();
}

function getNowISO() {
    return new Date().toISOString();
}

function handleOptions(request) {
    return new Response(null, {
        status: 200,
        headers: {
            'Allow': 'OPTIONS, GET, HEAD, POST, PUT, DELETE, PROPFIND, MKCOL, COPY, MOVE, LOCK, UNLOCK, PROPPATCH',
            'DAV': '1, 2',
            'MS-Author-Via': 'DAV',
            'Content-Length': '0',
            'Date': getNowRFC1123(),
        },
    });
}

async function handleHead(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/dav/' || path === '/dav') {
        return new Response(null, { status: 200 });
    }

    try {
        const filePath = path.replace(/^\/dav/, '');
        const fileUrl = new URL(`/file${filePath}`, request.url);
        const fileResponse = await fetch(fileUrl.toString(), { method: 'HEAD' });

        if (!fileResponse.ok) {
            return new Response(null, { status: 404 });
        }

        const headers = new Headers();
        headers.set('Content-Length', fileResponse.headers.get('Content-Length') || '0');
        headers.set('Content-Type', fileResponse.headers.get('Content-Type') || 'application/octet-stream');
        headers.set('Last-Modified', fileResponse.headers.get('Last-Modified') || getNowRFC1123());

        return new Response(null, { status: 200, headers });
    } catch (error) {
        return new Response(null, { status: 404 });
    }
}

async function handleGet(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/dav/, '') || '/';

    if (path.endsWith('/')) {
        try {
            const dir = path === '/' ? '' : path.substring(1, path.length - 1);
            const contents = await fetchDirectoryContents(dir, env, request);
            const html = generateDirectoryListingHtml(path, contents);
            return new Response(html, {
                headers: { 'Content-Type': 'text/html; charset=utf-8' }
            });
        } catch (error) {
            return new Response(`Error: ${error.message}`, { status: 500 });
        }
    } else {
        try {
            const fileUrl = new URL(`/file${path}`, request.url);
            const fileResponse = await fetch(fileUrl.toString());

            if (!fileResponse.ok) {
                return new Response('File not found', { status: 404 });
            }

            const headers = new Headers(fileResponse.headers);
            headers.set('Access-Control-Allow-Origin', '*');

            return new Response(fileResponse.body, { status: 200, headers });
        } catch (error) {
            return new Response(`Error: ${error.message}`, { status: 500 });
        }
    }
}

async function handlePut(request, env) {
    const url = new URL(request.url);
    const fullPath = decodeURIComponent(url.pathname.replace(/^\/dav\/?/, ''));

    if (!fullPath || fullPath.endsWith('/')) {
        return new Response('Invalid file name', { status: 400 });
    }

    const lastSlashIndex = fullPath.lastIndexOf('/');
    const uploadFolder = lastSlashIndex > -1 ? fullPath.substring(0, lastSlashIndex) : '';
    const fileName = lastSlashIndex > -1 ? fullPath.substring(lastSlashIndex + 1) : fullPath;

    const fileContent = await request.blob();
    const formData = new FormData();
    formData.append('file', fileContent, fileName);

    const uploadUrl = new URL('/upload', request.url);
    if (uploadFolder) {
        uploadUrl.searchParams.set('uploadFolder', uploadFolder);
    }

    const othersConfig = await fetchOthersConfig(env);
    const webdavConfig = othersConfig.webDAV || {};
    if (webdavConfig.uploadChannel) {
        uploadUrl.searchParams.set('uploadChannel', webdavConfig.uploadChannel);
    }
    if (webdavConfig.channelName) {
        uploadUrl.searchParams.set('channelName', webdavConfig.channelName);
    }

    try {
        const response = await fetch(uploadUrl.toString(), {
            method: 'POST',
            body: formData,
            headers: await getApiHeaders(env)
        });

        const result = await response.json();
        if (response.ok && Array.isArray(result) && result.length > 0 && result[0].src) {
            return new Response(null, { status: 201 });
        } else {
            const errorMsg = result.error || JSON.stringify(result);
            return new Response(`Upload failed: ${errorMsg}`, { status: 500 });
        }
    } catch (error) {
        return new Response('Failed to contact upload service', { status: 502 });
    }
}

async function handleDelete(request, env) {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname.replace(/^\/dav\/?/, ''));

    if (!path) return new Response('Invalid path', { status: 400 });

    const isFolder = path.endsWith('/');
    const cleanPath = isFolder ? path.slice(0, -1) : path;

    const deleteUrl = new URL(`/api/manage/delete/${cleanPath}`, request.url);
    if (isFolder) deleteUrl.searchParams.set('folder', 'true');

    try {
        const response = await fetch(deleteUrl.toString(), {
            method: 'DELETE',
            headers: await getApiHeaders(env)
        });
        const result = await response.json();
        if (result.success) {
            return new Response(null, { status: 204 });
        } else {
            return new Response(`Deletion failed: ${result.error || 'API error'}`, { status: 500 });
        }
    } catch (error) {
        return new Response(`Error: ${error.message}`, { status: 500 });
    }
}

async function handleMkcol(request, env) {
    return new Response(null, { status: 201 });
}

async function handleCopy(request, env) {
    return new Response('Copy not supported', { status: 501 });
}

async function handleMove(request, env) {
    return new Response('Move not supported', { status: 501 });
}

const lockTokens = new Map();

async function handleLock(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const lockToken = `opaquelocktoken:${crypto.randomUUID()}`;

    lockTokens.set(path, {
        token: lockToken,
        expires: Date.now() + 600000
    });

    const depth = request.headers.get('Depth') || '0';
    const timeout = request.headers.get('Timeout') || 'Second-600';

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:prop xmlns:D="DAV:">
<D:lockdiscovery>
<D:activelock>
<D:locktype><D:write/></D:locktype>
<D:lockscope><D:exclusive/></D:lockscope>
<D:depth>${depth}</D:depth>
<D:owner/>
<D:timeout>${timeout}</D:timeout>
<D:locktoken>
<D:href>${lockToken}</D:href>
</D:locktoken>
</D:activelock>
</D:lockdiscovery>
</D:prop>`;

    return new Response(xml, {
        status: 200,
        headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Lock-Token': `<${lockToken}>`,
        }
    });
}

async function handleUnlock(request, env) {
    const lockToken = request.headers.get('Lock-Token');
    const url = new URL(request.url);
    const path = url.pathname;

    if (lockToken) {
        lockTokens.delete(path);
    }

    return new Response(null, { status: 204 });
}

async function handleProppatch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
<D:response>
<D:href>${encodeURI(path)}</D:href>
<D:propstat>
<D:prop/>
<D:status>HTTP/1.1 200 OK</D:status>
</D:propstat>
</D:response>
</D:multistatus>`;

    return new Response(xml, {
        status: 207,
        headers: { 'Content-Type': 'application/xml; charset=utf-8' }
    });
}

async function handlePropfind(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/dav/, '') || '/';
    const depth = request.headers.get('Depth') || '1';

    try {
        const dir = path === '/' ? '' : path.substring(1, path.endsWith('/') ? path.length - 1 : path.length);
        const contents = await fetchDirectoryContents(dir, env, request);
        const xml = generateWebDAVXml(path, contents, depth, request);
        return new Response(xml, {
            status: 207,
            headers: {
                'Content-Type': 'application/xml; charset=utf-8',
                'DAV': '1, 2',
            }
        });
    } catch (error) {
        return new Response(`Error: ${error.message}`, { status: 500 });
    }
}

async function fetchDirectoryContents(dir, env, request) {
    const listUrl = new URL('/api/manage/list', request.url);
    listUrl.searchParams.set('dir', dir);
    listUrl.searchParams.set('count', '-1');

    const response = await fetch(listUrl.toString(), { headers: await getApiHeaders(env) });
    if (!response.ok) {
        throw new Error(`API fetch error: Status ${response.status}`);
    }

    const result = await response.json();
    if (result.error) {
        throw new Error(`API error: ${result.error}`);
    }

    return {
        files: result.files || [],
        directories: [...new Set(result.directories || [])]
    };
}

function generateDirectoryListingHtml(basePath, contents) {
    let links = '';

    if (basePath !== '/') {
        links += '<li><a href="../"><strong>../</strong></a></li>';
    }

    for (const dir of contents.directories) {
        const dirName = dir.split('/').pop();
        links += `<li><a href="${encodeURIComponent(dirName)}/"><strong>${dirName}/</strong></a></li>`;
    }

    for (const file of contents.files) {
        const fileName = file.name.split('/').pop();
        const fileSize = file.metadata?.FileSize ? `${file.metadata.FileSize} MB` : '';
        links += `<li><a href="${encodeURIComponent(fileName)}">${fileName}</a> ${fileSize}</li>`;
    }

    return `<!DOCTYPE html>
<html>
<head><title>Index of ${basePath}</title></head>
<body><h1>Index of ${basePath}</h1><ul>${links}</ul></body>
</html>`;
}

function generateWebDAVXml(basePath, contents, depth, request) {
    let responses = '';
    const now = getNowRFC1123();
    const currentPath = basePath.endsWith('/') ? basePath : `${basePath}/`;
    const origin = new URL(request.url).origin;

    responses += createCollectionResponse(origin, '/dav', currentPath, now);

    if (depth !== '0') {
        for (const dir of contents.directories) {
            const dirName = dir.split('/').pop();
            const dirPath = `${currentPath}${dirName}`;
            responses += createCollectionResponse(origin, '/dav', `${dirPath}/`, now);
        }
        for (const file of contents.files) {
            responses += createFileResponse(origin, '/dav', file, currentPath, now);
        }
    }

    return `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
${responses}
</D:multistatus>`;
}

function createCollectionResponse(origin, prefix, path, lastModified) {
    const fullPath = `${prefix}${path}`;
    const name = decodeURIComponent(path.split('/').filter(Boolean).pop() || '');

    return `<D:response>
<D:href>${encodeURI(fullPath)}</D:href>
<D:propstat>
<D:prop>
<D:displayname>${escapeXml(name)}</D:displayname>
<D:resourcetype><D:collection/></D:resourcetype>
<D:creationdate>${lastModified}</D:creationdate>
<D:getlastmodified>${lastModified}</D:getlastmodified>
</D:prop>
<D:status>HTTP/1.1 200 OK</D:status>
</D:propstat>
</D:response>
`;
}

function createFileResponse(origin, prefix, file, basePath, lastModified) {
    const fileName = file.name.split('/').pop();
    const fileSize = file.metadata?.FileSizeBytes || file.metadata?.FileSize || '0';
    const mimeType = file.metadata?.FileType || 'application/octet-stream';
    const fullPath = `${prefix}${basePath}${fileName}`;

    return `<D:response>
<D:href>${encodeURI(fullPath)}</D:href>
<D:propstat>
<D:prop>
<D:displayname>${escapeXml(fileName)}</D:displayname>
<D:resourcetype/>
<D:creationdate>${lastModified}</D:creationdate>
<D:getlastmodified>${lastModified}</D:getlastmodified>
<D:getcontentlength>${fileSize}</D:getcontentlength>
<D:getcontenttype>${mimeType}</D:getcontenttype>
</D:prop>
<D:status>HTTP/1.1 200 OK</D:status>
</D:propstat>
</D:response>
`;
}

function escapeXml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
