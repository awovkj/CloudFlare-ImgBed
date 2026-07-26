import { fetchSecurityConfig } from "../utils/sysConfig.js";
import { purgeCFCache, purgeRandomFileListCache, purgePublicFileListCache } from "../utils/purgeCache.js";
import { addFileToIndex } from "../utils/indexManager.js";
import { getDatabase } from '../utils/databaseAdapter.js';
import { CHAT_DIRECTORY, isChatRequestFromUrl } from '../utils/chat.js';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, authCode',
    'Access-Control-Max-Age': '86400',
};

export function createResponse(body, options = {}) {
    return new Response(body, {
        ...options,
        headers: { ...CORS_HEADERS, ...options.headers }
    });
}

export function generateShortId(length = 8) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

const UNKNOWN_IP_ADDRESS = '未知';

// 获取IP地址（通过管理端可配置的自定义查询 API，未配置时返回“未知”）
export async function getIPAddress(env, ip, securityConfig = null) {
    if (!env || !ip) return UNKNOWN_IP_ADDRESS;

    try {
        const config = securityConfig || await fetchSecurityConfig(env);
        const ipQuery = config?.upload?.ipQuery;

        if (!ipQuery?.enabled || ipQuery.channel !== 'customApi') {
            return UNKNOWN_IP_ADDRESS;
        }

        const customApi = ipQuery.customApi || {};
        if (!customApi.url) {
            return UNKNOWN_IP_ADDRESS;
        }

        const responseFields = Array.isArray(customApi.responseFields)
            ? customApi.responseFields
                .map(field => typeof field === 'string' ? field : field?.path || '')
                .filter(Boolean)
            : [];
        if (responseFields.length === 0) {
            return UNKNOWN_IP_ADDRESS;
        }

        const replaceIpPlaceholder = value => String(value ?? '').replace(/\{ip\}/g, ip);
        const queryUrl = new URL(replaceIpPlaceholder(customApi.url));
        const paramList = Array.isArray(customApi.params) ? customApi.params : [];
        for (const param of paramList) {
            const key = replaceIpPlaceholder(param?.key || '');
            if (!key) continue;
            queryUrl.searchParams.append(key, replaceIpPlaceholder(param?.value || ''));
        }

        const response = await fetch(queryUrl.toString());
        if (!response.ok) {
            return UNKNOWN_IP_ADDRESS;
        }

        const data = JSON.parse((await response.text()).trim());
        const formatValue = value => {
            if (Array.isArray(value)) {
                return value.map(formatValue).filter(Boolean).join(', ');
            }
            if (typeof value === 'object' && value !== null) {
                return JSON.stringify(value);
            }
            return String(value ?? '').trim();
        };

        const address = responseFields
            .map(path => {
                const value = String(path)
                    .replace(/\[(\d+)\]/g, '.$1')
                    .split('.')
                    .map(segment => segment.trim())
                    .filter(Boolean)
                    .reduce((current, segment) => {
                        if (current === undefined || current === null) return undefined;
                        return current[segment];
                    }, data);

                if (value === undefined || value === null || value === '') return '';
                return formatValue(value);
            })
            .filter(Boolean)
            .join('，');

        return address || UNKNOWN_IP_ADDRESS;
    } catch (error) {
        console.error('Error fetching IP address:', error);
        return UNKNOWN_IP_ADDRESS;
    }
}

export function sanitizeFileName(fileName) {
    // 仅在检测到合法 %xx 序列时才解码，避免 "100%.png" 等文件名触发 URIError
    if (/%[0-9a-fA-F]{2}/.test(fileName)) {
        try {
            fileName = decodeURIComponent(fileName);
        } catch {}
    }
    fileName = fileName.split('/').pop();
    return fileName.replace(/[\\\/:\*\?"'<>\| \(\)\[\]\{\}#%\^`~;@&=\+\$,]/g, '_');
}

const VALID_EXTENSIONS = new Set([
    'jpeg', 'jpg', 'png', 'gif', 'webp', 'ico', 'svg', 'bmp', 'tiff',
    'mp4', 'mov', 'avi', 'mkv', 'webm',
    'mp3', 'ogg', 'wav', 'flac', 'aac', 'opus',
    'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'pdf',
    'txt', 'md', 'json', 'xml', 'html', 'css', 'js', 'ts',
    'go', 'java', 'php', 'py', 'rb', 'sh', 'bat', 'cmd',
    'ps1', 'psm1', 'psd', 'ai', 'sketch', 'fig', 'eps',
    'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz',
    'apk', 'crx', 'xpi', 'deb', 'rpm',
    'exe', 'msi', 'dmg',
    'ttf', 'otf', 'woff', 'woff2', 'eot',
    'jar', 'war', 'ear',
    'iso', 'img', 'vdi', 'ova', 'ovf', 'qcow2', 'vmdk', 'vhd', 'vhdx', 'pvm', 'dsk', 'hdd',
    'bin', 'cue', 'mds', 'mdf', 'nrg', 'ccd', 'cif', 'c2d', 'daa',
    'b6t', 'b5t', 'bwt', 'isz', 'cdi', 'flp', 'uif', 'xdi', 'sdi',
    'torrent',
]);

export function isExtValid(fileExt) {
    return VALID_EXTENSIONS.has(fileExt);
}

export function sanitizeUploadFolder(folder) {
    if (!folder || folder.trim() === '') return '';

    let normalizedFolder = folder;
    if (/%[0-9a-fA-F]{2}/.test(normalizedFolder)) {
        try {
            normalizedFolder = decodeURIComponent(normalizedFolder);
        } catch {}
    }

    normalizedFolder = normalizedFolder.replace(/\.\./g, '_');
    // 新增：将单独的 . 路径段替换为 _（例如 /./）
    normalizedFolder = normalizedFolder.split('/').map(seg => seg === '.' ? '_' : seg).join('/');
    normalizedFolder = normalizedFolder.replace(/\\/g, '/');
    normalizedFolder = normalizedFolder.replace(/\/{2,}/g, '/');
    normalizedFolder = normalizedFolder.replace(/^\/+/, '').replace(/\/+$/, '');

    return normalizedFolder
        .split('/')
        .map((segment) => segment.replace(/[\\:\*\?"'<>\| \(\)\[\]\{\}#%\^`~;@&=\+\$,]/g, '_'))
        .filter((segment) => segment.length > 0)
        .join('/');
}

export function resolveFileExt(fileName, fileType = 'application/octet-stream') {
    let fileExt = fileName.split('.').pop();
    if (fileExt && fileExt !== fileName && isExtValid(fileExt)) {
        return fileExt;
    }

    const typePart = fileType.split('/').pop();
    if (typePart && typePart !== fileType) {
        return typePart;
    }

    return 'bin';
}

export function getImageDimensions(buffer, fileType) {
    try {
        const view = new DataView(buffer);
        const uint8 = new Uint8Array(buffer);

        if (uint8[0] === 0x89 && uint8[1] === 0x50 && uint8[2] === 0x4E && uint8[3] === 0x47) {
            return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
        }

        if (uint8[0] === 0xFF && uint8[1] === 0xD8 && uint8[2] === 0xFF) {
            let offset = 2;
            while (offset < buffer.byteLength - 9) {
                if (uint8[offset] !== 0xFF) break;
                const marker = uint8[offset + 1];
                if (marker >= 0xC0 && marker <= 0xC3 && marker !== 0xC4) {
                    return { width: view.getUint16(offset + 7, false), height: view.getUint16(offset + 5, false) };
                }
                offset += 2 + view.getUint16(offset + 2, false);
            }
            return null;
        }

        if (uint8[0] === 0x47 && uint8[1] === 0x49 && uint8[2] === 0x46) {
            return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
        }

        if (uint8[0] === 0x52 && uint8[1] === 0x49 && uint8[2] === 0x46 && uint8[3] === 0x46 &&
            uint8[8] === 0x57 && uint8[9] === 0x45 && uint8[10] === 0x42 && uint8[11] === 0x50) {
            if (uint8[12] === 0x56 && uint8[13] === 0x50 && uint8[14] === 0x38 && uint8[15] === 0x20) {
                if (buffer.byteLength >= 30) {
                    return { width: (view.getUint16(26, true) & 0x3FFF), height: (view.getUint16(28, true) & 0x3FFF) };
                }
            }
            if (uint8[12] === 0x56 && uint8[13] === 0x50 && uint8[14] === 0x38 && uint8[15] === 0x4C) {
                if (buffer.byteLength >= 25) {
                    const bits = view.getUint32(21, true);
                    return { width: (bits & 0x3FFF) + 1, height: ((bits >> 14) & 0x3FFF) + 1 };
                }
            }
            if (uint8[12] === 0x56 && uint8[13] === 0x50 && uint8[14] === 0x38 && uint8[15] === 0x58) {
                if (buffer.byteLength >= 30) {
                    return {
                        width: (uint8[24] | (uint8[25] << 8) | (uint8[26] << 16)) + 1,
                        height: (uint8[27] | (uint8[28] << 8) | (uint8[29] << 16)) + 1
                    };
                }
            }
            return null;
        }

        if (uint8[0] === 0x42 && uint8[1] === 0x4D) {
            return { width: view.getInt32(18, true), height: Math.abs(view.getInt32(22, true)) };
        }

        return null;
    } catch (error) {
        console.error('Error extracting image dimensions:', error);
        return null;
    }
}

export async function moderateContent(env, url, securityConfig = null) {
    if (!securityConfig) {
        securityConfig = await fetchSecurityConfig(env);
    }
    const uploadModerate = securityConfig.upload.moderate;

    if (!uploadModerate || !uploadModerate.enabled) {
        return "None";
    }

    if (uploadModerate.channel === 'moderatecontent.com') {
        const apikey = uploadModerate.moderateContentApiKey;
        if (!apikey) return "None";
        
        try {
            const params = new URLSearchParams({ key: apikey, url: url });
            const fetchResponse = await fetch('https://api.moderatecontent.com/moderate/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: params.toString()
            });
            if (!fetchResponse.ok) {
                throw new Error(`HTTP error! status: ${fetchResponse.status}`);
            }
            const moderate_data = await fetchResponse.json();
            return moderate_data.rating_label || "None";
        } catch (error) {
            console.error('Moderate Error:', error);
            return "None";
        }
    }

    if (uploadModerate.channel === 'nsfwjs') {
        const nsfwApiPath = uploadModerate.nsfwApiPath;
        try {
            const fetchResponse = await fetch(`${nsfwApiPath}?url=${encodeURIComponent(url)}`);
            if (!fetchResponse.ok) {
                throw new Error(`HTTP error! status: ${fetchResponse.status}`);
            }
            const moderate_data = await fetchResponse.json();
            const score = moderate_data.score || 0;
            if (score >= 0.9) return "adult";
            if (score >= 0.7) return "teen";
            return "everyone";
        } catch (error) {
            console.error('Moderate Error:', error);
            return "None";
        }
    }

    return "None";
}

export async function purgeCDNCache(env, cdnUrl, url, normalizedFolder) {
    if (env.dev_mode === 'true') return;

    await Promise.allSettled([
        purgeCFCache(env, cdnUrl).catch(error => console.error('Failed to clear CDN cache:', error)),
        purgeRandomFileListCache(url.origin, normalizedFolder),
        purgePublicFileListCache(url.origin, normalizedFolder),
    ]);
}

export async function endUpload(context, fileId, metadata) {
    const { env, url } = context;
    const cdnUrl = `https://${url.hostname}/file/${fileId}`;
    const normalizedFolder = sanitizeUploadFolder(url.searchParams.get('uploadFolder') || '');
    await purgeCDNCache(env, cdnUrl, url, normalizedFolder);
    await addFileToIndex(context, fileId, metadata);
}

const FALLBACK_HEADERS = [
    "x-real-ip", "x-forwarded-for", "x-client-ip", "true-client-ip",
    "x-host", "x-originating-ip", "x-cluster-client-ip",
    "forwarded-for", "forwarded", "via", "requester",
    "client-ip", "x-remote-ip", "fastly-client-ip",
    "akamai-origin-hop", "x-remote-addr", "x-remote-host", "x-client-ips"
];

export function getUploadIp(request) {
    const cfIp = request.headers.get("cf-connecting-ip");
    if (cfIp) return cfIp.split(',')[0].trim();

    for (const header of FALLBACK_HEADERS) {
        const value = request.headers.get(header);
        if (value) return value.split(',')[0].trim();
    }

    return null;
}

export async function isBlockedUploadIp(env, uploadIp) {
    try {
        const db = getDatabase(env);
        const list = await db.get("manage@blockipList");
        if (list == null) return false;
        return new Set(list.split(",")).has(uploadIp);
    } catch (error) {
        console.error('Failed to check blocked IP:', error);
        return false;
    }
}

// 构建唯一文件ID
export async function buildUniqueFileId(context, fileName, fileType = 'application/octet-stream') {
    const { env, url } = context;
    const db = getDatabase(env);

    if (isChatRequestFromUrl(url) && !url.searchParams.get('uploadFolder')) {
        url.searchParams.set('uploadFolder', CHAT_DIRECTORY);
    }

    let fileExt = fileName.split('.').pop();
    if (!fileExt || fileExt === fileName) {
        fileExt = fileType.split('/').pop();
        if (fileExt === fileType || !fileExt) fileExt = 'unknown';
    }

    const nameType = url.searchParams.get('uploadNameType') || 'default';
    const uploadFolder = url.searchParams.get('uploadFolder') || '';
    const normalizedFolder = uploadFolder
        ? sanitizeUploadFolder(uploadFolder)
        : '';

    if (!isExtValid(fileExt)) {
        fileExt = fileType.split('/').pop();
        if (fileExt === fileType || !fileExt) fileExt = 'unknown';
    }

    fileName = sanitizeFileName(fileName);
    const unique_index = Date.now() + Math.floor(Math.random() * 10000);

    if (nameType === 'short') {
        while (true) {
            const shortId = generateShortId(8);
            const testFullId = normalizedFolder ? `${normalizedFolder}/${shortId}.${fileExt}` : `${shortId}.${fileExt}`;
            if (await db.get(testFullId) === null) return testFullId;
        }
    }

    let baseId;
    if (nameType === 'index') {
        baseId = normalizedFolder ? `${normalizedFolder}/${unique_index}.${fileExt}` : `${unique_index}.${fileExt}`;
    } else if (nameType === 'origin') {
        baseId = normalizedFolder ? `${normalizedFolder}/${fileName}` : fileName;
    } else {
        baseId = normalizedFolder ? `${normalizedFolder}/${unique_index}_${fileName}` : `${unique_index}_${fileName}`;
    }

    if (await db.get(baseId) === null) return baseId;

    let counter = 1;
    while (counter <= 1000) {
        let duplicateId;
        if (nameType === 'index') {
            duplicateId = normalizedFolder ? `${normalizedFolder}/${unique_index}(${counter}).${fileExt}` : `${unique_index}(${counter}).${fileExt}`;
        } else if (nameType === 'origin') {
            const nameWithoutExt = fileName.substring(0, fileName.lastIndexOf('.'));
            const ext = fileName.substring(fileName.lastIndexOf('.'));
            duplicateId = normalizedFolder ? `${normalizedFolder}/${nameWithoutExt}(${counter})${ext}` : `${nameWithoutExt}(${counter})${ext}`;
        } else {
            const baseName = `${unique_index}_${fileName}`;
            const nameWithoutExt = baseName.substring(0, baseName.lastIndexOf('.'));
            const ext = baseName.substring(baseName.lastIndexOf('.'));
            duplicateId = normalizedFolder ? `${normalizedFolder}/${nameWithoutExt}(${counter})${ext}` : `${nameWithoutExt}(${counter})${ext}`;
        }

        if (await db.get(duplicateId) === null) return duplicateId;
        counter++;
    }

    throw new Error('无法生成唯一的文件ID');
}

export function buildReturnLink(url, fileId) {
    const returnFormat = url.searchParams.get('returnFormat') || 'default';
    if (returnFormat === 'full') {
        return `${url.origin}/file/${fileId}`;
    }
    return `/file/${fileId}`;
}

export function selectChannel(channelSettings, specifiedName = null, uploadId = null) {
    const channels = channelSettings.channels;
    if (!channels || channels.length === 0) return null;

    if (specifiedName) {
        const specified = channels.find(ch => ch.name === specifiedName);
        if (specified) return specified;
    }

    const loadBalanceEnabled = channelSettings.loadBalance?.enabled;

    if (uploadId) {
        return selectConsistentChannel(channels, uploadId, loadBalanceEnabled);
    }

    if (loadBalanceEnabled) {
        return channels[Math.floor(Math.random() * channels.length)];
    }
    return channels[0];
}

export function selectConsistentChannel(channels, uploadId, loadBalanceEnabled) {
    if (!loadBalanceEnabled || !channels || channels.length === 0) {
        return channels[0];
    }

    let hash = 0;
    for (let i = 0; i < uploadId.length; i++) {
        const char = uploadId.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }

    return channels[Math.abs(hash) % channels.length];
}
