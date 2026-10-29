import { removeFileFromIndex, batchRemoveFilesFromIndex } from "../../../utils/indexManager.js";
import { deleteStoredFile } from '../../../utils/deleteFile.js';

export { deleteStoredFile as deleteFile } from '../../../utils/deleteFile.js';

// CORS 跨域响应头
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
};

export async function onRequest(context) {
    const { request, env, params, waitUntil } = context;

    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (!['GET', 'DELETE'].includes(request.method)) {
        return jsonResponse({ success: false, error: 'Method not allowed' }, 405, { Allow: 'GET, DELETE, OPTIONS' });
    }

    // 读取folder参数，判断是否为文件夹删除请求
    const folder = url.searchParams.get('folder');
    if (folder === 'true') {
        const deletedFiles = [];
        const failedFiles = [];
        try {
            // 使用队列存储需要处理的文件夹
            const folderQueue = [{
                path: decodeURIComponent(params.path).split(',').join('/')
            }];
            const visitedFolders = new Set();
            const visitedFiles = new Set();

            while (folderQueue.length > 0) {
                const currentFolder = folderQueue.shift();
                if (visitedFolders.has(currentFolder.path)) continue;
                visitedFolders.add(currentFolder.path);

                // 获取指定目录下的所有文件
                const listUrl = new URL('/api/manage/list', url);
                listUrl.searchParams.set('count', '-1');
                listUrl.searchParams.set('dir', currentFolder.path);
                const listRequest = new Request(listUrl, {
                    headers: request.headers,
                });
                const listResponse = await fetch(listRequest);
                if (!listResponse.ok) {
                    throw new Error(`Failed to list folder contents: ${listResponse.status}`);
                }
                const listData = await listResponse.json();
                if (!listData || listData.success === false || listData.error ||
                    !Array.isArray(listData.files) || !Array.isArray(listData.directories)) {
                    throw new Error('Invalid folder listing');
                }
                const files = listData.files;

                // 处理当前文件夹下的所有文件
                for (const file of files) {
                    const fileId = file.name;
                    if (typeof fileId !== 'string' || !fileId) throw new Error('Invalid listed file');
                    if (visitedFiles.has(fileId)) continue;
                    visitedFiles.add(fileId);
                    const cdnUrl = fileUrl(url, fileId);

                    const success = await deleteStoredFile(env, fileId, cdnUrl, url);
                    if (success) {
                        deletedFiles.push(fileId);
                    } else {
                        failedFiles.push(fileId);
                    }
                }

                // 将子文件夹添加到队列
                const directories = listData.directories;
                for (const dir of directories) {
                    if (typeof dir !== 'string' || !dir) throw new Error('Invalid listed folder');
                    folderQueue.push({
                        path: dir
                    });
                }
            }

            return jsonResponse({
                success: failedFiles.length === 0,
                deleted: deletedFiles,
                failed: failedFiles
            });

        } catch (e) {
            console.error('Folder deletion failed:', e);
            return jsonResponse({
                success: false,
                error: 'Folder deletion failed',
                deleted: deletedFiles,
                failed: failedFiles,
            }, 400);
        } finally {
            // A later listing error must not leave earlier committed deletions indexed.
            if (deletedFiles.length > 0) {
                waitUntil(batchRemoveFilesFromIndex(context, deletedFiles));
            }
        }
    }

    // 单个文件删除处理
    try {
        // 解码params.path
        const fileId = decodeURIComponent(params.path).split(',').join('/');
        const cdnUrl = fileUrl(url, fileId);

        const success = await deleteStoredFile(env, fileId, cdnUrl, url);
        if (!success) {
            throw new Error('Delete file failed');
        } else {
            // 从索引中删除文件
            waitUntil(removeFileFromIndex(context, fileId));
        }

        return jsonResponse({
            success: true,
            fileId: fileId
        });
    } catch (e) {
        console.error('File deletion failed:', e);
        return jsonResponse({
            success: false,
            error: 'Delete file failed'
        }, 400);
    }
}

function fileUrl(url, fileId) {
    return `${url.origin}/file/${fileId.split('/').map(encodeURIComponent).join('/')}`;
}

function jsonResponse(payload, status = 200, headers = {}) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders, ...headers },
    });
}
