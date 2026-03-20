import { fetchSecurityConfig, fetchOthersConfig } from "../utils/sysConfig";

export async function onRequest(context) {
    const { request, env } = context;

    const authResponse = await checkAuth(request, env);
    if (authResponse) return authResponse;

    const url = new URL(request.url);
    url.pathname = url.pathname.replace(/^\/dav/, '') || '/';
    const modifiedRequest = new Request(url.toString(), request);

    switch (modifiedRequest.method) {
        case 'OPTIONS': return handleOptions(modifiedRequest);
        case 'PROPFIND': return handlePropfind(modifiedRequest, env);
        case 'PUT': return handlePut(modifiedRequest, env);
        case 'DELETE': return handleDelete(modifiedRequest, env);
        case 'GET': return handleGet(modifiedRequest, env);
        case 'HEAD': return handleHead(modifiedRequest, env);
        case 'MKCOL': return handleMkcol(modifiedRequest, env);
        case 'COPY': return handleCopy(modifiedRequest, env);
        case 'MOVE': return handleMove(modifiedRequest, env);
        case 'LOCK': return handleLock(modifiedRequest, env);
        case 'UNLOCK': return handleUnlock(modifiedRequest, env);
        case 'PROPPATCH': return handleProppatch(modifiedRequest, env);
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
        return new Response('Authorization required', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="WebDAV"' },
        });
    }

    const [scheme, encoded] = authHeader.split(' ');
    if (scheme !== 'Basic' || !encoded) {
        return new Response('Malformed Authorization header', { status: 400 });
    }

    const decoded = atob(encoded);
    const colonIndex = decoded.indexOf(':');
    if (colonIndex === -1) {
        return new Response('Malformed credentials', { status: 400 });
    }

    const user = decoded.substring(0, colonIndex);
    const pass = decoded.substring(colonIndex + 1);

    if (user !== davUser || pass !== davPass) {
        return new Response('Invalid credentials', { status: 403 });
    }

    return null;
}

function formatWebDAVDate(date) {
    return date.toUTCString();
}

function getNowRFC1123() {
    return new Date().toUTCString();
}

function handleOptions(request) {
    return new Response(null, {
        status: 200,
        headers: {
            'Allow': 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, COPY, MOVE, LOCK, UNLOCK, PROPPATCH',
            'DAV': '1, 2',
            'MS-Author-Via': 'DAV',
            'Content-Length': '0',
        },
    });
}

async function handleHead(request, env) {
    const path = decodeURIComponent(new URL(request.url).pathname);

    if (path.endsWith('/')) {
        return new Response(null, { status: 200 });
    }

    try {
        const fileUrl = new URL(`/file${path}`, request.url);
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
    const path = decodeURIComponent(new URL(request.url).pathname);

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

            return new Response(fileResponse.body, { 
                status: 200, 
                headers 
            });
        } catch (error) {
            return new Response(`Error: ${error.message}`, { status: 500 });
        }
    }
}

async function handlePut(request, env) {
    const fullPath = decodeURIComponent(new URL(request.url).pathname.substring(1));
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
    const path = decodeURIComponent(new URL(request.url).pathname.substring(1));
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
    const path = decodeURIComponent(new URL(request.url).pathname);
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
    const path = decodeURIComponent(new URL(request.url).pathname);

    if (lockToken) {
        const cleanToken = lockToken.replace(/[<>]/g, '');
        lockTokens.delete(path);
    }

    return new Response(null, { status: 204 });
}

async function handleProppatch(request, env) {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
    <D:response>
        <D:href>${encodeURI(decodeURIComponent(new URL(request.url).pathname))}</D:href>
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
    const path = decodeURIComponent(new URL(request.url).pathname);
    const depth = request.headers.get('Depth') || '1';

    try {
        const dir = path === '/' ? '' : path.substring(1, path.endsWith('/') ? path.length - 1 : path.length);
        const contents = await fetchDirectoryContents(dir, env, request);
        const xml = generateWebDAVXml(path, contents, depth);
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

function generateWebDAVXml(basePath, contents, depth) {
    let responses = '';
    const now = getNowRFC1123();
    const currentPath = basePath.endsWith('/') ? basePath : `${basePath}/`;

    responses += createCollectionResponse(currentPath, now);

    if (depth !== '0') {
        for (const dir of contents.directories) {
            const dirName = dir.split('/').pop();
            responses += createCollectionResponse(`${currentPath}${encodeURIComponent(dirName)}/`, now);
        }
        for (const file of contents.files) {
            responses += createFileResponse(file, currentPath, now);
        }
    }

    return `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:ns0="DAV:">
${responses}
</D:multistatus>`;
}

function createCollectionResponse(href, lastModified) {
    return `<D:response>
    <D:href>${href}</D:href>
    <D:propstat>
        <D:prop>
            <D:displayname>${decodeURIComponent(href.split('/').filter(Boolean).pop() || '')}</D:displayname>
            <D:resourcetype><D:collection/></D:resourcetype>
            <D:creationdate>${lastModified}</D:creationdate>
            <D:getlastmodified>${lastModified}</D:getlastmodified>
            <D:supportedlock>
                <D:lockentry>
                    <D:locktype><D:write/></D:locktype>
                    <D:lockscope><D:exclusive/></D:lockscope>
                </D:lockentry>
            </D:supportedlock>
        </D:prop>
        <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
</D:response>`;
}

function createFileResponse(file, basePath, lastModified) {
    const fileName = file.name.split('/').pop();
    const fileSize = file.metadata?.FileSizeBytes || file.metadata?.FileSize || '0';
    const mimeType = file.metadata?.FileType || 'application/octet-stream';
    const href = `${basePath}${encodeURIComponent(fileName)}`;

    return `<D:response>
    <D:href>${href}</D:href>
    <D:propstat>
        <D:prop>
            <D:displayname>${fileName}</D:displayname>
            <D:resourcetype/>
            <D:creationdate>${lastModified}</D:creationdate>
            <D:getlastmodified>${lastModified}</D:getlastmodified>
            <D:getcontentlength>${fileSize}</D:getcontentlength>
            <D:getcontenttype>${mimeType}</D:getcontenttype>
            <D:supportedlock>
                <D:lockentry>
                    <D:locktype><D:write/></D:locktype>
                    <D:lockscope><D:exclusive/></D:lockscope>
                </D:lockentry>
            </D:supportedlock>
        </D:prop>
        <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
</D:response>`;
}
