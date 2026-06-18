#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const files = {
  index: path.join(root, 'index.html'),
  indexGz: path.join(root, 'index.html.gz'),
  uploadChunk: path.join(root, 'js', '274.9b7364f3.js'),
  uploadChunkGz: path.join(root, 'js', '274.9b7364f3.js.gz'),
  uploadMap: path.join(root, 'js', '274.9b7364f3.js.map'),
  uploadMapGz: path.join(root, 'js', '274.9b7364f3.js.map.gz'),
  helper: path.join(root, 'js', 'tg-upload-lanes.js'),
  helperGz: path.join(root, 'js', 'tg-upload-lanes.js.gz'),
};

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function writeText(file, text) {
  fs.writeFileSync(file, text, 'utf8');
  console.log(`patched ${path.relative(root, file)}`);
}

function writeGzip(sourceFile, gzipFile) {
  fs.writeFileSync(gzipFile, zlib.gzipSync(fs.readFileSync(sourceFile)));
  console.log(`regenerated ${path.relative(root, gzipFile)}`);
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(needle, pos)) !== -1) {
    count += 1;
    pos += needle.length;
  }
  return count;
}

function replaceOnce(text, from, to, label) {
  const count = countOccurrences(text, from);
  if (count !== 1) {
    throw new Error(`${label}: expected exactly one match, found ${count}`);
  }
  return text.replace(from, to);
}

function replaceCount(text, from, to, expectedCount, label) {
  const count = countOccurrences(text, from);
  if (count !== expectedCount) {
    throw new Error(`${label}: expected ${expectedCount} matches, found ${count}`);
  }
  return text.split(from).join(to);
}

function replaceOnceUnless(text, marker, from, to, label) {
  if (text.includes(marker)) {
    console.log(`skip ${label}: marker already present`);
    return text;
  }
  return replaceOnce(text, from, to, label);
}

function patchIndex() {
  const helperScript = '<script src="/js/tg-upload-lanes.js"></script>';
  let html = readText(files.index);
  if (!html.includes(helperScript)) {
    html = replaceOnce(
      html,
      '<script src="/js/file-stats-widget.js"></script>',
      `${helperScript}<script src="/js/file-stats-widget.js"></script>`,
      'index helper script insertion'
    );
    writeText(files.index, html);
  } else {
    console.log('skip index.html: helper script already present');
  }
  writeGzip(files.index, files.indexGz);
}

function patchUploadChunk() {
  let js = readText(files.uploadChunk);

  js = replaceOnceUnless(
    js,
    'tgActiveChannels:{}',
    'uploadQueue:[],activeUploads:0,maxConcurrentUploads:6,abortControllers:new Map',
    'uploadQueue:[],tgUploadQueue:[],tgActiveChannels:{},tgChannelList:[],activeUploads:0,maxConcurrentUploads:6,abortControllers:new Map',
    'UploadForm data TG queue fields'
  );

  js = replaceOnceUnless(
    js,
    'this.refreshTelegramChannels()',
    'mounted(){document.addEventListener("paste",this.handlePaste),this.autoReUpload=this.storeAutoReUpload},beforeUnmount(){document.removeEventListener("paste",this.handlePaste),this.uploadQueue=[],this.fileList=[],this.activeUploads=0}',
    'mounted(){document.addEventListener("paste",this.handlePaste),this.autoReUpload=this.storeAutoReUpload,this.refreshTelegramChannels()},beforeUnmount(){document.removeEventListener("paste",this.handlePaste),this.uploadQueue=[],this.tgUploadQueue=[],this.tgActiveChannels={},this.fileList=[],this.activeUploads=0}',
    'UploadForm mounted/beforeUnmount TG setup'
  );

  const originalUploadFile = 'uploadFile(e){if(!this.fileList.find(t=>t.uid===e.file.uid))return;if(this.activeUploads>=this.maxConcurrentUploads){this.uploadQueue.push(e);const t=this.fileList.find(t=>t.uid===e.file.uid);return void(t&&(t.status="waiting"))}this.activeUploads++;const t=this.fileList.find(t=>t.uid===e.file.uid);t&&(t.status="uploading");const o=this.fileList.find(t=>t.uid===e.file.uid),s=o?.uploadChannel||this.uploadChannel;if("external"===s)return void this.uploadSingleFile(e);if("huggingface"===s){const t=20971520;return void(e.file.size>=t?this.uploadToHuggingFaceDirect(e):this.uploadSingleFile(e))}if("discord"===s){const t=9437184;return void(e.file.size>t?this.uploadFileInChunks(e):this.uploadSingleFile(e))}const l=20971520;e.file.size>l?this.uploadFileInChunks(e):this.uploadSingleFile(e)},processUploadQueue';
  const patchedUploadFile = 'uploadFile(e){if(!this.fileList.find(t=>t.uid===e.file.uid))return;const t=this.fileList.find(t=>t.uid===e.file.uid),o=t?.uploadChannel||this.uploadChannel;if("telegram"===o)return void this.enqueueTelegramUpload(e);if(this.activeUploads>=this.maxConcurrentUploads){this.uploadQueue.push(e);const t=this.fileList.find(t=>t.uid===e.file.uid);return void(t&&(t.status="waiting"))}this.activeUploads++;const s=this.fileList.find(t=>t.uid===e.file.uid);s&&(s.status="uploading");if("external"===o)return void this.uploadSingleFile(e);if("huggingface"===o){const t=20971520;return void(e.file.size>=t?this.uploadToHuggingFaceDirect(e):this.uploadSingleFile(e))}if("discord"===o){const t=9437184;return void(e.file.size>t?this.uploadFileInChunks(e):this.uploadSingleFile(e))}const l=20971520;e.file.size>l?this.uploadFileInChunks(e):this.uploadSingleFile(e)},processUploadQueue';
  js = replaceOnceUnless(js, 'enqueueTelegramUpload(e)', originalUploadFile, patchedUploadFile, 'UploadForm uploadFile TG dispatch');

  const originalOnUploadComplete = 'onUploadComplete(){this.activeUploads=Math.max(0,this.activeUploads-1),this.processUploadQueue(),0===this.activeUploads&&0===this.uploadQueue.length&&(this.uploading=!1)},async uploadSingleFile';
  const tgMethods = 'onUploadComplete(){this.activeUploads=Math.max(0,this.activeUploads-1),this.processUploadQueue(),0===this.activeUploads&&0===this.uploadQueue.length&&0===this.tgUploadQueue.length&&0===Object.keys(this.tgActiveChannels).length&&(this.uploading=!1)},async refreshTelegramChannels(){try{const e=await(0,ht.A)({url:"/api/channels",method:"get",withAuthCode:!0});this.tgChannelList=e.data&&Array.isArray(e.data.telegram)?e.data.telegram:[]}catch(e){console.warn("Failed to load Telegram channels for upload lanes:",e),this.tgChannelList=[]}},enqueueTelegramUpload(e){const t=this.fileList.find(t=>t.uid===e.file.uid);t&&(this.tgUploadQueue.find(t=>t.file.uid===e.file.uid)||(this.tgUploadQueue.push(e),t.status="waiting"),this.processTelegramUploadQueue())},processTelegramUploadQueue(){const e=window.TgUploadLaneScheduler;if(!e)return void console.warn("TgUploadLaneScheduler is not loaded");while(this.tgUploadQueue.length>0){const t=e.acquireAvailableLane(this.tgActiveChannels,this.channelName,this.tgChannelList);if(!t)return;const o=this.tgUploadQueue.shift(),s=o&&this.fileList.find(e=>e.uid===o.file.uid);if(!o||!s){e.releaseLane(this.tgActiveChannels,t);continue}s.tgUploadLane=t,s.channelName=e.channelNameForLane(t),s.status="uploading";const l=20971520;o.file.size>l?this.uploadFileInChunks(o):this.uploadSingleFile(o)}},onTelegramUploadComplete(e){const t=this.fileList.find(t=>t.uid===e),o=window.TgUploadLaneScheduler;o&&t&&t.tgUploadLane&&o.releaseLane(this.tgActiveChannels,t.tgUploadLane),t&&(delete t.tgUploadLane,delete t.channelName),this.processTelegramUploadQueue(),0===this.tgUploadQueue.length&&0===Object.keys(this.tgActiveChannels).length&&0===this.activeUploads&&0===this.uploadQueue.length&&(this.uploading=!1)},async uploadSingleFile';
  js = replaceOnceUnless(js, 'processTelegramUploadQueue()', originalOnUploadComplete, tgMethods, 'UploadForm TG scheduler methods');

  js = replaceOnceUnless(
    js,
    't.channelName||this.channelName',
    '(0,ht.A)({url:"/upload?serverCompress="+o+"&uploadChannel="+s+(this.channelName?"&channelName="+encodeURIComponent(this.channelName):"")+"&uploadNameType="+a+"&autoRetry="+l+"&uploadFolder="+this.uploadFolder',
    '(0,ht.A)({url:"/upload?serverCompress="+o+"&uploadChannel="+s+((t.channelName||this.channelName)?"&channelName="+encodeURIComponent(t.channelName||this.channelName):"")+"&uploadNameType="+a+"&autoRetry="+l+"&uploadFolder="+this.uploadFolder',
    'UploadForm direct upload assigned TG channel'
  );

  js = replaceOnceUnless(
    js,
    '__tgChannelName=t.channelName||this.channelName',
    'const l="discord"===o?9437184:18874368,a=e.file.size,i=Math.ceil(a/l),n=t.serverCompress,r=this.autoRetry&&"external"!==o,d="external"===o?"default":this.uploadNameType;let c=null;',
    'const l="discord"===o?9437184:18874368,a=e.file.size,i=Math.ceil(a/l),n=t.serverCompress,r=this.autoRetry&&"external"!==o,d="external"===o?"default":this.uploadNameType,__tgChannelName=t.channelName||this.channelName;let c=null;',
    'UploadForm chunk upload assigned TG channel variable'
  );

  if (js.includes('__tgChannelName=t.channelName||this.channelName')) {
    js = replaceCount(
      js,
      '(this.channelName?"&channelName="+encodeURIComponent(this.channelName):"")',
      '(__tgChannelName?"&channelName="+encodeURIComponent(__tgChannelName):"")',
      countOccurrences(js, '(this.channelName?"&channelName="+encodeURIComponent(this.channelName):"")'),
      'UploadForm chunk upload assigned TG channel URL replacements'
    );
  }

  js = replaceOnceUnless(
    js,
    '"telegram"===s?this.onTelegramUploadComplete(e.file.uid):this.onUploadComplete()',
    'finally(()=>{this.abortControllers.delete(e.file.uid),this.onUploadComplete()})},async uploadFileInChunks',
    'finally(()=>{this.abortControllers.delete(e.file.uid),"telegram"===s?this.onTelegramUploadComplete(e.file.uid):this.onUploadComplete()})},async uploadFileInChunks',
    'UploadForm direct upload TG completion'
  );

  js = replaceOnceUnless(
    js,
    '"telegram"===o?this.onTelegramUploadComplete(e.file.uid):this.onUploadComplete()}',
    'finally{this.abortControllers.delete(e.file.uid),this.onUploadComplete()}},handleRemove',
    'finally{this.abortControllers.delete(e.file.uid),"telegram"===o?this.onTelegramUploadComplete(e.file.uid):this.onUploadComplete()}},handleRemove',
    'UploadForm chunk upload TG completion'
  );

  const originalHandleRemove = 'handleRemove(e){this.abortControllers.has(e.uid)&&(this.abortControllers.get(e.uid).abort(),this.abortControllers.delete(e.uid)),this.uploadQueue=this.uploadQueue.filter(t=>t.file.uid!==e.uid),this.fileList=this.fileList.filter(t=>t.uid!==e.uid),this.$message({type:"info",message:this.truncateFilename(e.name)+"已删除"})},async cleanupUploadResources';
  const patchedHandleRemove = 'handleRemove(e){const t=this.fileList.find(t=>t.uid===e.uid),o=window.TgUploadLaneScheduler;o&&t&&t.tgUploadLane&&o.releaseLane(this.tgActiveChannels,t.tgUploadLane),o&&(this.tgUploadQueue=o.removeQueuedFile(this.tgUploadQueue,e.uid)),this.abortControllers.has(e.uid)&&(this.abortControllers.get(e.uid).abort(),this.abortControllers.delete(e.uid)),this.uploadQueue=this.uploadQueue.filter(t=>t.file.uid!==e.uid),this.fileList=this.fileList.filter(t=>t.uid!==e.uid),this.processTelegramUploadQueue(),this.$message({type:"info",message:this.truncateFilename(e.name)+"已删除"})},async cleanupUploadResources';
  js = replaceOnceUnless(js, 'removeQueuedFile(this.tgUploadQueue', originalHandleRemove, patchedHandleRemove, 'UploadForm handleRemove TG cleanup');

  js = replaceOnceUnless(
    js,
    'clearFileList(){this.fileList.length>0?(this.abortControllers.forEach((e,t)=>{e.abort()}),this.abortControllers.clear(),this.uploadQueue=[],this.tgUploadQueue=[]',
    'clearFileList(){this.fileList.length>0?(this.abortControllers.forEach((e,t)=>{e.abort()}),this.abortControllers.clear(),this.uploadQueue=[],this.fileList=[],this.$message({type:"success",message:"文件列表已清空"}))',
    'clearFileList(){this.fileList.length>0?(this.abortControllers.forEach((e,t)=>{e.abort()}),this.abortControllers.clear(),this.uploadQueue=[],this.tgUploadQueue=[],this.tgActiveChannels={},this.fileList=[],this.$message({type:"success",message:"文件列表已清空"}))',
    'UploadForm clearFileList TG cleanup'
  );

  writeText(files.uploadChunk, js);
  writeGzip(files.uploadChunk, files.uploadChunkGz);
}

function patchSourceMap() {
  const marker = 'webpack://sanyue_imghub/./src/utils/upload/tgUploadLanesRuntimePatch.js';
  const map = JSON.parse(readText(files.uploadMap));
  if (!map.sources.includes(marker)) {
    map.sources.push(marker);
    map.sourcesContent = Array.isArray(map.sourcesContent) ? map.sourcesContent : [];
    map.sourcesContent.push('/* Runtime patch: Telegram uploads are scheduled one file per channel lane. See js/tg-upload-lanes.js. */\n');
    writeText(files.uploadMap, JSON.stringify(map));
  } else {
    console.log('skip upload source map: marker already present');
  }
  writeGzip(files.uploadMap, files.uploadMapGz);
}

if (!fs.existsSync(files.helper)) {
  throw new Error('js/tg-upload-lanes.js must exist before applying runtime patch');
}

patchIndex();
patchUploadChunk();
patchSourceMap();
writeGzip(files.helper, files.helperGz);
console.log('tg upload lanes runtime patch complete');
