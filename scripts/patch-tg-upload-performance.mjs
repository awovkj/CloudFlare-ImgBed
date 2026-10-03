#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uploadBundlePath = path.join(root, 'js', '274.9b7364f3.js');

function countOccurrences(text, needle) {
    let count = 0;
    let offset = 0;

    while ((offset = text.indexOf(needle, offset)) !== -1) {
        count += 1;
        offset += needle.length;
    }

    return count;
}

function replaceExactlyOnce(text, from, to, label) {
    if (text.includes(to)) {
        return text;
    }

    const matches = countOccurrences(text, from);
    if (matches !== 1) {
        throw new Error(`${label}: expected one source match, found ${matches}`);
    }

    return text.replace(from, to);
}

let changedFiles = 0;

{
    let bundle = fs.readFileSync(uploadBundlePath, 'utf8');

    // Telegram 分片并发：4 → 2。
    //
    // 为什么降：分片请求既不带 uploadId（URL 与 X-Upload-Id 都没有，uploadId
    // 只出现在 FormData 里），而 shouldRouteUploadToDurableObject() 对
    // chunked=true 且无 uploadId 的请求返回 false —— 所以分片根本不经
    // Durable Object，DO 的 runSerial 串行队列从未生效。
    //
    // 于是前端并发 N 就是真的 N 个 Worker 并发打 Telegram，而 Telegram 对同一
    // chat 的限速约 1 条/秒。并发 4 必然触发 429，等待 retry_after 期间连接被
    // 关闭（ERR_CONNECTION_CLOSED），表现为「每个分片都失败一次、重试才成功」。
    // 先把 bundle 归一化回「未打补丁」形态，兼容已打过旧版补丁（?4）的 bundle；
    // 再统一降级到 ?2。顺序很重要 —— 否则 replaceExactlyOnce 在已打补丁的
    // bundle 上会因找不到原始片段而抛错。
    //
    // 后续修正：分片请求现在会带上 uploadId 并路由到 DO（见下方 Chunk DO
    // routing），runSerial 串行队列开始真正生效，同一 uploadId 的分片不再
    // 并发打 Telegram。并发 2 予以保留 —— 代价只是多一个请求在 DO 队列里排队，
    // 而 DO 侧本来就是串行的。
    const normalized = bundle.replace(
        'const f="telegram"===o?4:"discord"===o?3:6,',
        'const f=("discord"===o||"telegram"===o)?3:6,',
    );
    let patchedBundle = replaceExactlyOnce(
        normalized,
        'const f=("discord"===o||"telegram"===o)?3:6,',
        'const f="telegram"===o?2:"discord"===o?3:6,',
        'Telegram chunk concurrency'
    );
    patchedBundle = replaceExactlyOnce(
        patchedBundle,
        'let b=0;const v=5;while(b<v)',
        'let b=0;const v="telegram"===o?3:5;while(b<v)',
        'Telegram request retry count'
    );

    // 分片请求带上 uploadId，让它落到 Durable Object 上。
    //
    // 为什么：分片 URL 原本没有 uploadId（也不带 X-Upload-Id），uploadId 只塞在
    // FormData 里；而 extractUploadId() 只对 merge 请求解析 body，其余直接取
    // URL/header，于是 shouldRouteUploadToDurableObject() 对「chunked=true 且无
    // uploadId」返回 false —— 分片全部落在 Worker 上，吃 Worker 的 CPU 预算
    // （Free 计划仅 10ms），DO 的 runSerial 串行队列也从未生效。
    //
    // URL 带上 uploadId 后，extractRouteUploadId() 无需解析大 body 即可完成路由，
    // 同一 uploadId 的分片全部进同一个 DO 实例，由 runSerial 串行执行。
    // 路由时 URL 里的 uploadId 会与 FormData 里的做一致性校验
    // （handleChunkUpload 内的 assertRouteUploadIdMatches），两者同取自 h。
    patchedBundle = replaceExactlyOnce(
        patchedBundle,
        '"&uploadFolder="+this.uploadFolder+"&chunked=true",method:"post",data:f,',
        '"&uploadFolder="+this.uploadFolder+"&chunked=true&uploadId="+encodeURIComponent(h),method:"post",data:f,',
        'Chunk DO routing'
    );

    // Removing an active Telegram file used to release its lane before the
    // aborted requests had actually left their catch/finally path. The queue
    // could then start the next file while old chunks were still in flight,
    // breaking the global one-file invariant. Capture lane ownership when an
    // upload starts, and only release it from the upload's finalizer.
    patchedBundle = replaceExactlyOnce(
        patchedBundle,
        'onTelegramUploadComplete(e){const t=this.fileList.find(t=>t.uid===e),o=window.TgUploadLaneScheduler;o&&t&&t.tgUploadLane&&o.releaseLane(this.tgActiveChannels,t.tgUploadLane),t&&(delete t.tgUploadLane,delete t.channelName),',
        'onTelegramUploadComplete(e,t){const o=this.fileList.find(t=>t.uid===e),s=window.TgUploadLaneScheduler,l=t||(o&&o.tgUploadLane);s&&l&&s.releaseLane(this.tgActiveChannels,l),o&&(delete o.tgUploadLane,delete o.channelName),',
        'Telegram lane finalizer ownership'
    );
    patchedBundle = replaceExactlyOnce(
        patchedBundle,
        'async uploadSingleFile(e){const t=this.fileList.find(t=>t.uid===e.file.uid);if(!t)return;const o=t.serverCompress,',
        'async uploadSingleFile(e){const t=this.fileList.find(t=>t.uid===e.file.uid);if(!t)return;const __tgLane=t.tgUploadLane,o=t.serverCompress,',
        'Telegram single-file lane capture'
    );
    patchedBundle = replaceExactlyOnce(
        patchedBundle,
        '"telegram"===s?this.onTelegramUploadComplete(e.file.uid):this.onUploadComplete()',
        '"telegram"===s?this.onTelegramUploadComplete(e.file.uid,__tgLane):this.onUploadComplete()',
        'Telegram single-file lane release'
    );
    patchedBundle = replaceExactlyOnce(
        patchedBundle,
        'async uploadFileInChunks(e){const t=this.fileList.find(t=>t.uid===e.file.uid);if(!t)return;const o=t.uploadChannel||this.uploadChannel,',
        'async uploadFileInChunks(e){const t=this.fileList.find(t=>t.uid===e.file.uid);if(!t)return;const __tgLane=t.tgUploadLane,o=t.uploadChannel||this.uploadChannel,',
        'Telegram chunked lane capture'
    );
    patchedBundle = replaceExactlyOnce(
        patchedBundle,
        '&initChunked=true",method:"post",data:t,withAuthCode:!0});if(!p.data.success)',
        '&initChunked=true",method:"post",data:t,withAuthCode:!0,signal:s.signal});if(!p.data.success)',
        'Telegram chunk initialization cancellation'
    );
    patchedBundle = replaceExactlyOnce(
        patchedBundle,
        '"telegram"===o?this.onTelegramUploadComplete(e.file.uid):this.onUploadComplete()',
        '"telegram"===o?this.onTelegramUploadComplete(e.file.uid,__tgLane):this.onUploadComplete()',
        'Telegram chunked lane release'
    );
    patchedBundle = replaceExactlyOnce(
        patchedBundle,
        'handleRemove(e){const t=this.fileList.find(t=>t.uid===e.uid),o=window.TgUploadLaneScheduler;o&&t&&t.tgUploadLane&&o.releaseLane(this.tgActiveChannels,t.tgUploadLane),o&&(this.tgUploadQueue=o.removeQueuedFile(this.tgUploadQueue,e.uid)),',
        'handleRemove(e){const t=this.fileList.find(t=>t.uid===e.uid),o=window.TgUploadLaneScheduler;o&&(this.tgUploadQueue=o.removeQueuedFile(this.tgUploadQueue,e.uid)),',
        'Telegram removal lane release'
    );
    patchedBundle = replaceExactlyOnce(
        patchedBundle,
        'clearFileList(){this.fileList.length>0?(this.abortControllers.forEach((e,t)=>{e.abort()}),this.abortControllers.clear(),this.uploadQueue=[],this.tgUploadQueue=[],this.tgActiveChannels={},this.fileList=[],',
        'clearFileList(){this.fileList.length>0?(this.abortControllers.forEach((e,t)=>{e.abort()}),this.abortControllers.clear(),this.uploadQueue=[],this.tgUploadQueue=[],this.fileList=[],',
        'Telegram clear-all lane release'
    );

    if (patchedBundle !== bundle) {
        fs.writeFileSync(uploadBundlePath, patchedBundle, 'utf8');
        changedFiles += 1;
    }
}

console.log(`✓ Applied Telegram large-upload performance patch (${changedFiles} file${changedFiles === 1 ? '' : 's'} updated)`);
