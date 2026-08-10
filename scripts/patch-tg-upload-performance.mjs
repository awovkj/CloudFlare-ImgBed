#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uploadBundleRelativePath = path.join('js', '274.9b7364f3.js');
const uploadBundlePaths = [
    path.join(root, uploadBundleRelativePath),
    path.join(root, 'frontend-dist', uploadBundleRelativePath),
].filter((candidate, index, candidates) =>
    fs.existsSync(candidate) && candidates.indexOf(candidate) === index
);

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

for (const uploadBundlePath of uploadBundlePaths) {
    let bundle = fs.readFileSync(uploadBundlePath, 'utf8');

    let patchedBundle = replaceExactlyOnce(
        bundle,
        'const f=("discord"===o||"telegram"===o)?3:6,',
        'const f="telegram"===o?4:"discord"===o?3:6,',
        'Telegram chunk concurrency'
    );
    patchedBundle = replaceExactlyOnce(
        patchedBundle,
        'let b=0;const v=5;while(b<v)',
        'let b=0;const v="telegram"===o?3:5;while(b<v)',
        'Telegram request retry count'
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

// frontend-dist is generated and ignored by git, but Wrangler uses it when it
// already exists. Keep the separately loaded lane scheduler in sync as well,
// otherwise a direct `wrangler deploy` could silently ship the old scheduler.
const laneSourcePath = path.join(root, 'js', 'tg-upload-lanes.js');
const laneTargetPath = path.join(root, 'frontend-dist', 'js', 'tg-upload-lanes.js');
if (fs.existsSync(laneSourcePath) && fs.existsSync(laneTargetPath)) {
    const laneSource = fs.readFileSync(laneSourcePath, 'utf8');
    if (fs.readFileSync(laneTargetPath, 'utf8') !== laneSource) {
        fs.copyFileSync(laneSourcePath, laneTargetPath);
        changedFiles += 1;
    }
}

console.log(`✓ Applied Telegram large-upload performance patch (${changedFiles} file${changedFiles === 1 ? '' : 's'} updated)`);
