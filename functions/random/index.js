import { fetchOthersConfig } from "../utils/sysConfig";
import { readIndex } from "../utils/indexManager";
import { detectDevice, resolveOrientation, addClientHintsHeaders } from "./adaptive.js";

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
};

let othersConfig = {};
let allowRandom = false;

export async function onRequest(context) {
    // Contents of context object
    const {
      request, // same as existing Worker API
      env, // same as existing Worker API
      params, // if filename includes [id] or [[path]]
      waitUntil, // same as ctx.waitUntil in existing Worker API
      next, // used for middleware or to fetch assets
      data, // arbitrary space for passing data between middlewares
    } = context;
    const requestUrl = new URL(request.url);

    if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }

    // 读取其他设置
    othersConfig = await fetchOthersConfig(env);
    allowRandom = othersConfig.randomImageAPI.enabled;
    const allowedDir = othersConfig.randomImageAPI.allowedDir;

    // 检查是否启用了随机图功能
    if (allowRandom != true) {
        return new Response(JSON.stringify({ error: "Random is disabled" }), { status: 403, headers: corsHeaders });
    }

    // 处理允许的目录，每个目录调整为标准格式，去掉首尾空格，去掉开头的/，替换多个连续的/为单个/，去掉末尾的/
    const allowedDirList = allowedDir.split(',');
    const allowedDirListFormatted = allowedDirList.map(item => {
        return item.trim().replace(/^\/+/, '').replace(/\/{2,}/g, '/').replace(/\/$/, '');
    });

    // 从params中读取返回的文件类型
    let fileType = requestUrl.searchParams.get('content');
    if (fileType == null) {
        fileType = ['image'];
    } else {
        fileType = fileType.split(',');
    }

    // 读取图片方向参数：landscape(横图), portrait(竖图), square(方图)
    const orientationParam = requestUrl.searchParams.get('orientation') || '';
    const VALID_ORIENTATIONS = ['landscape', 'portrait', 'square'];
    let orientation = '';
    let isAutoMode = false;
    if (VALID_ORIENTATIONS.includes(orientationParam)) {
        orientation = orientationParam;
    } else if (orientationParam === 'auto') {
        isAutoMode = true;
        const deviceInfo = detectDevice(request);
        orientation = resolveOrientation(deviceInfo);
    }

    // 读取指定文件夹
    const paramDir = requestUrl.searchParams.get('dir') || '';
    const dir = paramDir.replace(/^\/+/, '').replace(/\/{2,}/g, '/').replace(/\/$/, '');

    // 检查是否在允许的目录中，或是允许目录的子目录
    let dirAllowed = false;
    for (let i = 0; i < allowedDirListFormatted.length; i++) {
        if (allowedDirListFormatted[i] === '' || dir === allowedDirListFormatted[i] || dir.startsWith(allowedDirListFormatted[i] + '/')) {
            dirAllowed = true;
            break;
        }
    }
    if (!dirAllowed) {
        return new Response(JSON.stringify({ error: "Directory not allowed" }), { status: 403, headers: corsHeaders });
    }

    let allRecords = await getRandomFileList(context, requestUrl, dir, fileType, orientation);

    // 自动方向模式下若该方向无匹配，回退为不限方向重新查询（而非复用同一个已过滤的空数组）
    if (isAutoMode && orientation && allRecords.length === 0) {
        allRecords = await getRandomFileList(context, requestUrl, dir, fileType, '');
    }

    const responseHeaders = new Headers(corsHeaders);
    if (isAutoMode) {
        addClientHintsHeaders(responseHeaders);
    }

    if (allRecords.length == 0) {
        return new Response(JSON.stringify({}), { status: 200, headers: responseHeaders });
    } else {
        const randomIndex = Math.floor(Math.random() * allRecords.length);
        const randomKey = allRecords[randomIndex];
        const randomPath = '/file/' + randomKey.name;
        let randomUrl = randomPath;

        const randomType = requestUrl.searchParams.get('type');
        const resType = requestUrl.searchParams.get('form');
        
        // if param 'type' is set to 'url', return the full URL
        if (randomType == 'url') {
            randomUrl = requestUrl.origin + randomPath;
        }

        // if param 'type' is set to 'img', return the image
        if (randomType == 'img') {
            // Return an image response
            randomUrl = requestUrl.origin + randomPath;
            const upstreamRes = await fetch(randomUrl);
            if (!upstreamRes.ok) {
                return new Response(JSON.stringify({ error: 'Failed to fetch random file' }), { status: 502, headers: responseHeaders });
            }

            const headers = new Headers(responseHeaders);
            const contentType = upstreamRes.headers.get('content-type') || 'image/jpeg';
            headers.set('Content-Type', contentType);

            const contentLength = upstreamRes.headers.get('content-length');
            if (contentLength) {
                headers.set('Content-Length', contentLength);
            }

            return new Response(upstreamRes.body, {
                headers,
                status: 200
            });
        }
        
        if (resType == 'text') {
            return new Response(randomUrl, { status: 200, headers: responseHeaders });
        } else {
            return new Response(JSON.stringify({ url: randomUrl }), { status: 200, headers: responseHeaders });
        }
    }
}

async function getRandomFileList(context, url, dir, fileTypes = ['image'], orientation = '') {
    const normalizedTypes = Array.isArray(fileTypes) ? fileTypes.filter(Boolean) : ['image'];
    const readIndexTypeFilters = normalizedTypes.filter(type =>
        type === 'image' || type === 'video' || type === 'audio' || type === 'other'
    );

    const typeKey = normalizedTypes.slice().sort().join(',');
    const cacheKey = `${url.origin}/api/randomFileList?dir=${dir}&content=${typeKey}&orientation=${orientation}`;

    // 检查缓存中是否有记录，有则直接返回
    const cache = caches.default;
    const cacheRes = await cache.match(cacheKey);
    if (cacheRes) {
        return JSON.parse(await cacheRes.text());
    }

    let allRecords = await readIndex(context, {
        directory: dir,
        count: -1,
        includeSubdirFiles: true,
        accessStatus: 'normal',
        fileType: readIndexTypeFilters
    });

    // 仅保留记录的name和metadata中的必要字段
    allRecords = allRecords.files?.map(item => {
        return {
            name: item.id,
            FileType: item.metadata?.FileType,
            Width: item.metadata?.Width,
            Height: item.metadata?.Height
        }
    });

    allRecords = allRecords.filter(item => {
        return normalizedTypes.some(type => item.FileType?.includes(type));
    });

    if (orientation && allRecords.length > 0) {
        const SQUARE_THRESHOLD = 0.1;
        allRecords = allRecords.filter(item => {
            if (!item.Width || !item.Height) return false;

            const ratio = item.Width / item.Height;
            switch (orientation) {
                case 'landscape':
                    return ratio > (1 + SQUARE_THRESHOLD);
                case 'portrait':
                    return ratio < (1 - SQUARE_THRESHOLD);
                case 'square':
                    return ratio >= (1 - SQUARE_THRESHOLD) && ratio <= (1 + SQUARE_THRESHOLD);
                default:
                    return true;
            }
        });
    }

    // 缓存结果，缓存时间为24小时
    await cache.put(cacheKey, new Response(JSON.stringify(allRecords), {
        headers: {
            "Content-Type": "application/json",
        }
    }), {
        expirationTtl: 24 * 60 * 60
    });
    
    return allRecords;
}
