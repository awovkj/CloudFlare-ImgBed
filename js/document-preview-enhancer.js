/**
 * 文档在线预览增强脚本
 *
 * 在文件详情对话框中注入"文档预览"按钮，支持：
 * - PDF：浏览器内置查看器（iframe 嵌入）
 * - DOCX：本地 docx-preview，隔离在禁止联网的 sandbox iframe
 * - XLS/XLSX：本地 SheetJS Worker，限制 ZIP 展开量、表格大小与解析时间
 * - DOC/PPT/PPTX：用户明确授权后由 Microsoft 获取匿名公开文件
 * - Markdown（md/markdown）：本地 marked.js 按需加载、白名单清洗
 * - 文本/代码（txt/log/json/xml/yml/csv/js/py 等）：纯文本 / JSON 格式化显示
 *
 * 设计原则：
 * - 纯原生 JS 实现，不依赖 Vue/Element Plus 内部 API
 * - 通过 MutationObserver 监听文件详情对话框出现（与 temp-link-enhancer 同模式）
 * - 预览请求复用页面同源 Cookie，与图片/视频预览行为一致
 * - 文本最大 2 MiB；本地 Office 最大 15 MiB；关闭弹窗时取消请求与 Worker
 * - 绝不自动向第三方发送私密文件 URL 或临时链接
 *
 * 预览链接一律带 ?preview=1（下载按钮带 ?download=1）：
 * - 让 /file/ 明确返回 Content-Disposition: inline 与按扩展名推断的 Content-Type，
 *   否则 metadata.FileType 为 octet-stream 的文件在 nosniff 下只会触发下载；
 * - 同时换掉缓存键，绕过浏览器/CDN 里 max-age=2592000 的旧响应
 *   （旧响应带的是 octet-stream，不换 URL 的话修好后端也依旧是下载）。
 */
(function attachDocumentPreviewEnhancer(global) {
    'use strict';

    var INJECTED_FLAG = 'data-doc-preview-injected';
    var DIALOG_TITLE = '文件详情';
    var MODAL_ID = 'doc-preview-modal-overlay';
    var MARKED_SOURCES = ['/js/vendor/marked-11.2.0.min.js'];
    var MAX_TEXT_BYTES = 2 * 1024 * 1024;
    var MAX_OFFICE_BYTES = 15 * 1024 * 1024;
    var PARSE_TIMEOUT_MS = 15000;
    var FILE_TIMEOUT_MS = 30000;

    var originalFetch = global.fetch ? global.fetch.bind(global) : null;
    // 当前预览模态框的全局键盘监听引用，关闭时同步释放。
    var modalEscHandler = null;
    var modalCleanups = [];
    var previousFocus = null;

    // ==================== 类型识别 ====================

    var EXT_CATEGORY_MAP = {};
    function registerCategory(category, extensions) {
        for (var i = 0; i < extensions.length; i++) {
            EXT_CATEGORY_MAP[extensions[i]] = category;
        }
    }
    registerCategory('pdf', ['pdf']);
    registerCategory('office', [
        'doc', 'dot', 'docx', 'dotx', 'docm', 'dotm',
        'xls', 'xlt', 'xlsx', 'xltx', 'xlsm', 'xltm', 'xlsb', 'ods',
        'ppt', 'pot', 'pps', 'pptx', 'potx', 'ppsx', 'pptm', 'potm', 'ppsm',
        'wps', 'et', 'dps',
    ]);
    registerCategory('markdown', ['md', 'markdown', 'mdown']);
    registerCategory('text', [
        'txt', 'log', 'json', 'xml', 'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg',
        'csv', 'tsv', 'js', 'mjs', 'ts', 'jsx', 'tsx', 'css', 'scss', 'less',
        'html', 'htm', 'py', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs',
        'php', 'rb', 'sh', 'bat', 'ps1', 'sql', 'env', 'vue', 'srt', 'vtt',
    ]);

    var CATEGORY_LABELS = {
        pdf: 'PDF 文档',
        office: 'Office 文档',
        markdown: 'Markdown',
        text: '文本/代码',
    };

    var MIME_CATEGORY_MAP = {
        'application/pdf': 'pdf',
        'application/msword': 'office',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'office',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.template': 'office',
        'application/vnd.ms-word.document.macroenabled.12': 'office',
        'application/vnd.ms-word.template.macroenabled.12': 'office',
        'application/vnd.ms-excel': 'office',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'office',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.template': 'office',
        'application/vnd.ms-excel.sheet.macroenabled.12': 'office',
        'application/vnd.ms-excel.template.macroenabled.12': 'office',
        'application/vnd.ms-excel.sheet.binary.macroenabled.12': 'office',
        'application/vnd.oasis.opendocument.spreadsheet': 'office',
        'application/vnd.ms-powerpoint': 'office',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'office',
        'application/vnd.openxmlformats-officedocument.presentationml.template': 'office',
        'application/vnd.openxmlformats-officedocument.presentationml.slideshow': 'office',
        'application/vnd.ms-powerpoint.presentation.macroenabled.12': 'office',
        'application/vnd.ms-powerpoint.template.macroenabled.12': 'office',
        'application/vnd.ms-powerpoint.slideshow.macroenabled.12': 'office',
        'text/markdown': 'markdown',
        'text/x-markdown': 'markdown',
        'application/json': 'text',
        'application/xml': 'text',
    };

    function safeFileUrl(value) {
        try {
            var url = new URL(value, global.location.origin);
            if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
            return url;
        } catch (e) { return null; }
    }

    function getExtension(fileId) {
        if (!fileId) return null;
        var value = String(fileId).split(/[?#]/)[0];
        var name = value.split('/').pop() || value;
        try { name = decodeURIComponent(name); } catch (e) { /* retain the original name */ }
        var dot = name.lastIndexOf('.');
        if (dot === -1 || dot === name.length - 1) return null;
        return name.slice(dot + 1).toLowerCase();
    }

    function getDocCategory(fileId, mimeType) {
        var name = typeof fileId === 'object' && fileId ? (fileId.fileName || fileId.fileId) : fileId;
        var mime = String(mimeType || (fileId && fileId.mimeType) || '').split(';')[0].trim().toLowerCase();
        var ext = getExtension(name);
        if (ext && EXT_CATEGORY_MAP[ext]) return EXT_CATEGORY_MAP[ext];
        return MIME_CATEGORY_MAP[mime] || (mime.indexOf('text/') === 0 ? 'text' : null);
    }

    function getOfficeFormat(fileInfo) {
        var ext = getExtension(fileInfo.fileName || fileInfo.fileId);
        var mime = String(fileInfo.mimeType || '').split(';')[0].trim().toLowerCase();
        if (['docx', 'dotx', 'docm', 'dotm'].indexOf(ext) !== -1 || /wordprocessingml|ms-word\.(?:document|template)/.test(mime)) return 'docx';
        if (['xls', 'xlt', 'xlsx', 'xltx', 'xlsm', 'xltm', 'xlsb', 'ods'].indexOf(ext) !== -1 || /ms-excel|spreadsheet/.test(mime)) return 'sheet';
        if (['doc', 'dot', 'ppt', 'pot', 'pps', 'pptx', 'potx', 'ppsx', 'pptm', 'potm', 'ppsm'].indexOf(ext) !== -1 || /msword|powerpoint|presentationml/.test(mime)) return 'online';
        return 'unsupported';
    }

    function readDialogValue(dialogEl, label) {
        var labels = dialogEl.querySelectorAll('.el-descriptions__label, .el-descriptions-item__label');
        for (var i = 0; i < labels.length; i++) {
            if (labels[i].textContent.trim().replace(/[：:]$/, '') !== label) continue;
            var content = labels[i].nextElementSibling;
            if (!content && labels[i].parentElement) {
                content = labels[i].parentElement.querySelector('.el-descriptions__content, .el-descriptions-item__content');
            }
            if (content) {
                var input = content.querySelector('input');
                return input ? input.value : content.textContent.trim();
            }
        }
        return '';
    }

    // ==================== 对话框信息提取 ====================

    // 提取当前详情对话框中文件的访问 URL 与 fileId
    // 策略与 temp-link-enhancer 保持一致：预览元素 src → 链接输入框 → el-image
    function extractFileUrlFromDialog(dialogEl) {
        var candidates = [];
        var previewImg = dialogEl.querySelector('.image-preview img, img.image-preview');
        if (previewImg && previewImg.src) candidates.push(previewImg.src);
        var previewVideo = dialogEl.querySelector('.video-preview');
        if (previewVideo && previewVideo.src) candidates.push(previewVideo.src);
        var previewAudio = dialogEl.querySelector('.audio-preview');
        if (previewAudio && previewAudio.src) candidates.push(previewAudio.src);

        var inputs = dialogEl.querySelectorAll('.el-tabs .el-input__inner, .el-tabs input');
        for (var i = 0; i < inputs.length; i++) {
            var val = inputs[i].value || '';
            if (val.indexOf('/file/') !== -1 || val.indexOf('/temp/') !== -1) candidates.push(val);
        }

        dialogEl.querySelectorAll('a[href]').forEach(function (link) {
            if (/\/(file|temp)\//.test(link.href)) candidates.push(link.href);
        });

        var elImageImg = dialogEl.querySelector('.el-image img, .el-image__inner');
        if (elImageImg && elImageImg.src) candidates.push(elImageImg.src);

        for (var j = 0; j < candidates.length; j++) {
            var fileId = parseFileIdFromUrl(candidates[j]);
            if (fileId) {
                var absoluteUrl = safeFileUrl(candidates[j]);
                if (absoluteUrl) return {
                    url: absoluteUrl.href,
                    fileId: fileId,
                    fileName: readDialogValue(dialogEl, '文件名') || getDisplayName(fileId),
                    mimeType: readDialogValue(dialogEl, '文件类型'),
                };
            }
        }
        return null;
    }

    function parseFileIdFromUrl(url) {
        try {
            var u = safeFileUrl(url);
            if (!u) return null;
            var match = u.pathname.match(/^\/(?:file|temp)\/(.+)$/);
            if (match) {
                // fileId 中的 , 还原为 /（与后端约定一致）
                return decodeURIComponent(match[1]).split(',').join('/');
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    function getDisplayName(fileId) {
        var name = (fileId || '').split('/').pop() || fileId || '未命名文件';
        try {
            return decodeURIComponent(name);
        } catch (e) {
            return name;
        }
    }

    // ==================== 访问意图（inline / attachment） ====================

    // 在文件 URL 上标记访问意图：preview=1 → 内联预览，download=1 → 强制下载。
    // 两者互斥，切换时清掉另一个，避免出现 ?preview=1&download=1 这种矛盾链接。
    function withIntent(url, intent) {
        try {
            var u = safeFileUrl(url);
            if (!u) return null;
            // This UI hint is not an authentication credential; cookies carry the session.
            u.searchParams.delete('from');
            // The server prioritizes disposition over preview/download flags.
            u.searchParams.delete('disposition');
            if (intent === 'download') {
                u.searchParams.delete('preview');
                u.searchParams.set('download', '1');
            } else {
                u.searchParams.delete('download');
                u.searchParams.set('preview', '1');
            }
            return u.href;
        } catch (e) {
            return null;
        }
    }

    function previewUrlOf(fileInfo) {
        return withIntent(fileInfo.url, 'preview');
    }

    // ==================== 样式注入 ====================

    function injectStyles() {
        if (document.getElementById('doc-preview-enhancer-styles')) return;
        var style = document.createElement('style');
        style.id = 'doc-preview-enhancer-styles';
        style.textContent = [
            '@keyframes docPreviewToastIn { from { opacity:0; transform:translate(-50%,-10px); } to { opacity:1; transform:translate(-50%,0); } }',
            '@keyframes docPreviewModalIn { from { opacity:0; transform:translateY(-16px); } to { opacity:1; transform:translateY(0); } }',
            '.doc-preview-toast {',
            '  position:fixed;top:20px;left:50%;transform:translateX(-50%);',
            '  background:#909399;color:#fff;padding:10px 20px;border-radius:8px;',
            '  box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:10001;',
            '  font-size:14px;font-family:inherit;animation:docPreviewToastIn 0.3s ease;',
            '}',
            '.doc-preview-overlay {',
            '  position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:10000;',
            '  display:flex;align-items:center;justify-content:center;',
            '  animation:docPreviewModalIn 0.2s ease;',
            '}',
            '.doc-preview-modal {',
            '  background:var(--el-bg-color,#fff);border-radius:12px;',
            '  box-shadow:0 12px 32px rgba(0,0,0,0.25);',
            '  width:92%;max-width:1100px;height:85vh;',
            '  display:flex;flex-direction:column;overflow:hidden;',
            '  font-family:inherit;color:var(--el-text-color-primary,inherit);',
            '}',
            '.doc-preview-header {',
            '  padding:14px 20px;border-bottom:1px solid var(--el-border-color-lighter,#eee);',
            '  display:flex;justify-content:space-between;align-items:center;gap:12px;min-width:0;',
            '}',
            '.doc-preview-title {',
            '  font-size:15px;font-weight:600;overflow:hidden;',
            '  text-overflow:ellipsis;white-space:nowrap;min-width:0;',
            '}',
            '.doc-preview-badge {',
            '  display:inline-block;margin-left:8px;padding:1px 8px;border-radius:10px;',
            '  font-size:11px;font-weight:400;vertical-align:middle;',
            '  background:var(--el-color-primary-light-9,#ecf5ff);',
            '  color:var(--el-color-primary,#409eff);',
            '}',
            '.doc-preview-toolbar { display:flex;align-items:center;gap:8px;flex-shrink:0; }',
            '.doc-preview-open-btn {',
            '  padding:6px 14px;background:var(--el-color-primary,#409eff);color:#fff;',
            '  border:none;border-radius:6px;cursor:pointer;font-size:13px;font-family:inherit;',
            '  white-space:nowrap;',
            '}',
            '.doc-preview-open-btn:hover { opacity:0.9; }',
            '.doc-preview-download-btn {',
            '  padding:6px 14px;background:transparent;',
            '  color:var(--el-color-primary,#409eff);',
            '  border:1px solid var(--el-color-primary,#409eff);border-radius:6px;',
            '  cursor:pointer;font-size:13px;font-family:inherit;white-space:nowrap;',
            '}',
            '.doc-preview-download-btn:hover { background:var(--el-color-primary-light-9,#ecf5ff); }',
            '.doc-preview-close-btn {',
            '  background:none;border:none;font-size:20px;cursor:pointer;',
            '  color:var(--el-text-color-secondary,#909399);padding:4px 8px;border-radius:4px;',
            '  line-height:1;',
            '}',
            '.doc-preview-close-btn:hover { background:var(--el-fill-color-light,#f5f7fa); }',
            '.doc-preview-body {',
            '  flex:1;overflow:auto;min-height:0;',
            '  display:flex;flex-direction:column;',
            '}',
            '.doc-preview-frame { width:100%;height:100%;border:none;flex:1; }',
            '.doc-preview-sheet-controls { display:flex;align-items:center;gap:10px;padding:8px 16px; }',
            '.doc-preview-sheet-controls select { max-width:70%;font:inherit;padding:4px 8px; }',
            '.doc-preview-sheet-scroll { overflow:auto;flex:1;min-height:0; }',
            '.doc-preview-sheet { border-collapse:collapse;font-size:13px;white-space:pre-wrap; }',
            '.doc-preview-sheet th,.doc-preview-sheet td { border:1px solid var(--el-border-color-lighter,#ddd);padding:6px 10px;min-width:60px;max-width:360px;overflow-wrap:anywhere; }',
            '.doc-preview-sheet th { background:var(--el-fill-color-light,#f5f7fa);position:sticky;top:0; }',
            '.doc-preview-consent { padding:24px;display:flex;flex-direction:column;align-items:flex-start;gap:16px;line-height:1.6; }',
            '.doc-preview-consent p { margin:0; }',
            '.doc-preview-hint {',
            '  padding:8px 16px;font-size:12px;color:var(--el-text-color-secondary,#909399);',
            '  background:var(--el-fill-color-light,#f5f7fa);border-bottom:1px solid var(--el-border-color-lighter,#eee);',
            '}',
            '.doc-preview-loading, .doc-preview-error {',
            '  flex:1;display:flex;align-items:center;justify-content:center;',
            '  color:var(--el-text-color-secondary,#909399);font-size:14px;padding:24px;text-align:center;',
            '}',
            '.doc-preview-error { color:var(--el-color-danger,#f56c6c); }',
            '.doc-preview-text {',
            '  margin:0;padding:16px;font-family:Consolas,Menlo,monospace;',
            '  font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-all;',
            '  color:var(--el-text-color-regular,#606266);flex:1;',
            '}',
            // Markdown 渲染样式（GitHub 风格基础版）
            '.doc-preview-markdown { padding:20px 24px;overflow:auto;flex:1;font-size:14px;line-height:1.7; }',
            '.doc-preview-markdown h1, .doc-preview-markdown h2,',
            '.doc-preview-markdown h3, .doc-preview-markdown h4,',
            '.doc-preview-markdown h5, .doc-preview-markdown h6 {',
            '  margin:1em 0 0.5em;font-weight:600;line-height:1.35;',
            '}',
            '.doc-preview-markdown h1 { font-size:1.7em;border-bottom:1px solid var(--el-border-color-lighter,#eee);padding-bottom:0.3em; }',
            '.doc-preview-markdown h2 { font-size:1.4em;border-bottom:1px solid var(--el-border-color-lighter,#eee);padding-bottom:0.25em; }',
            '.doc-preview-markdown h3 { font-size:1.2em; }',
            '.doc-preview-markdown p { margin:0.6em 0; }',
            '.doc-preview-markdown ul, .doc-preview-markdown ol { padding-left:1.6em;margin:0.6em 0; }',
            '.doc-preview-markdown li { margin:0.25em 0; }',
            '.doc-preview-markdown code {',
            '  background:var(--el-fill-color-light,#f5f7fa);border-radius:4px;',
            '  padding:0.15em 0.4em;font-family:Consolas,Menlo,monospace;font-size:0.9em;',
            '}',
            '.doc-preview-markdown pre {',
            '  background:var(--el-fill-color-darker,#f0f2f5);border-radius:8px;',
            '  padding:12px 14px;overflow-x:auto;margin:0.8em 0;',
            '}',
            '.doc-preview-markdown pre code { background:none;padding:0;font-size:0.9em; }',
            '.doc-preview-markdown blockquote {',
            '  margin:0.8em 0;padding:0.2em 1em;color:var(--el-text-color-secondary,#909399);',
            '  border-left:4px solid var(--el-border-color,#dcdfe6);',
            '}',
            '.doc-preview-markdown table { border-collapse:collapse;margin:0.8em 0;display:block;overflow-x:auto; }',
            '.doc-preview-markdown th, .doc-preview-markdown td {',
            '  border:1px solid var(--el-border-color-lighter,#eee);padding:6px 12px;',
            '}',
            '.doc-preview-markdown th { background:var(--el-fill-color-light,#f5f7fa);font-weight:600; }',
            '.doc-preview-markdown a { color:var(--el-color-primary,#409eff);text-decoration:none; }',
            '.doc-preview-markdown a:hover { text-decoration:underline; }',
            '.doc-preview-markdown img { max-width:100%;border-radius:6px; }',
            '.doc-preview-markdown hr { border:none;border-top:1px solid var(--el-border-color-lighter,#eee);margin:1.2em 0; }',
            '@media (max-width:640px) {',
            '  .doc-preview-overlay { animation:none; }',
            '  .doc-preview-modal { width:100vw;max-width:100%;box-sizing:border-box;height:100%;height:100dvh;border-radius:0; }',
            '  .doc-preview-header { padding:10px 12px;flex-wrap:wrap;gap:8px; }',
            '  .doc-preview-title { width:100%;font-size:14px; }',
            '  .doc-preview-toolbar { width:100%;justify-content:flex-end; }',
            '  .doc-preview-open-btn,.doc-preview-download-btn { padding:6px 10px; }',
            '  .doc-preview-markdown { padding:14px; }',
            '}',
            '@media (prefers-reduced-motion:reduce) { .doc-preview-overlay,.doc-preview-toast { animation:none; } }',
        ].join('\n');
        document.head.appendChild(style);
    }

    // ==================== 通用 UI ====================

    function showToast(message, type) {
        var colors = {
            success: '#67c23a',
            error: '#f56c6c',
            info: '#909399',
            warning: '#e6a23c',
        };
        var toast = document.createElement('div');
        toast.className = 'doc-preview-toast';
        toast.textContent = message;
        toast.style.background = colors[type] || colors.info;
        document.body.appendChild(toast);
        setTimeout(function () {
            toast.style.transition = 'opacity 0.3s ease';
            toast.style.opacity = '0';
            setTimeout(function () { toast.remove(); }, 300);
        }, 2500);
    }

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ==================== 预览模态框 ====================

    function closeModal() {
        if (modalEscHandler) {
            document.removeEventListener('keydown', modalEscHandler);
            modalEscHandler = null;
        }
        var existing = document.getElementById(MODAL_ID);
        modalCleanups.splice(0).forEach(function (cleanup) {
            try { cleanup(); } catch (e) { /* already closed */ }
        });
        if (existing) existing.remove();
        if (previousFocus && previousFocus.isConnected && previousFocus.focus) previousFocus.focus();
        previousFocus = null;
    }

    function openPreviewModal(fileInfo, category) {
        if (!fileInfo || !safeFileUrl(fileInfo.url)) {
            showToast('文件链接不是有效的 HTTP(S) 地址', 'error');
            return;
        }
        closeModal(); // 确保只有一个模态框
        previousFocus = document.activeElement;

        var fileName = fileInfo.fileName || getDisplayName(fileInfo.fileId);
        var categoryLabel = CATEGORY_LABELS[category] || '文档';

        var overlay = document.createElement('div');
        overlay.className = 'doc-preview-overlay';
        overlay.id = MODAL_ID;

        var modal = document.createElement('div');
        modal.className = 'doc-preview-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-label', fileName + ' 预览');
        modal.innerHTML =
            '<div class="doc-preview-header">' +
            '  <div class="doc-preview-title">' + escapeHtml(fileName) +
            '    <span class="doc-preview-badge">' + escapeHtml(categoryLabel) + '</span>' +
            '  </div>' +
            '  <div class="doc-preview-toolbar">' +
            '    <button class="doc-preview-download-btn" title="强制下载原文件">下载</button>' +
            '    <button class="doc-preview-open-btn" title="在新标签页打开原文件">新窗口打开</button>' +
            '    <button class="doc-preview-close-btn" title="关闭">&times;</button>' +
            '  </div>' +
            '</div>' +
            '<div class="doc-preview-body">' +
            '  <div class="doc-preview-loading">加载中...</div>' +
            '</div>';

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        overlay.querySelector('.doc-preview-close-btn').addEventListener('click', closeModal);
        overlay.querySelector('.doc-preview-open-btn').addEventListener('click', function () {
            // 新窗口同样带 preview=1，否则可能命中旧的 octet-stream 缓存而变成下载
            global.open(previewUrlOf(fileInfo), '_blank', 'noopener,noreferrer');
        });
        overlay.querySelector('.doc-preview-download-btn').addEventListener('click', function () {
            var link = document.createElement('a');
            link.href = withIntent(fileInfo.url, 'download');
            link.rel = 'noopener noreferrer';
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            link.remove();
        });
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) closeModal();
        });
        modalEscHandler = function (e) {
            if (e.key === 'Escape') {
                closeModal();
            } else if (e.key === 'Tab') {
                var buttons = modal.querySelectorAll('button, select, a[href], iframe');
                var first = buttons[0];
                var last = buttons[buttons.length - 1];
                if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            }
        };
        document.addEventListener('keydown', modalEscHandler);
        overlay.querySelector('.doc-preview-close-btn').focus();

        var body = modal.querySelector('.doc-preview-body');
        renderPreview(body, fileInfo, category);
    }

    function setBodyContent(body, html) {
        body.innerHTML = html;
    }

    function showError(body, message) {
        setBodyContent(body, '<div class="doc-preview-error">' + escapeHtml(message) + '</div>');
    }

    function renderPreview(body, fileInfo, category) {
        if (category === 'pdf') {
            renderPdfPreview(body, fileInfo);
        } else if (category === 'office') {
            renderOfficePreview(body, fileInfo);
        } else if (category === 'markdown') {
            renderMarkdownPreview(body, fileInfo);
        } else {
            renderTextPreview(body, fileInfo);
        }
    }

    // PDF：iframe + 浏览器内置查看器
    function renderPdfPreview(body, fileInfo) {
        headFile(previewUrlOf(fileInfo), 'same-origin').then(function () {
            if (!body.isConnected) return;
            setBodyContent(body,
                '<div class="doc-preview-hint">使用浏览器内置 PDF 查看器，按需加载文件。若移动浏览器无法嵌入，请使用“新窗口打开”或“下载”。</div>' +
                '<iframe class="doc-preview-frame" referrerpolicy="same-origin" src="' + escapeHtml(previewUrlOf(fileInfo)) + '" title="PDF 预览"></iframe>');
        }).catch(function (error) { if (body.isConnected) showError(body, '加载失败：' + error.message); });
    }

    function renderOfficePreview(body, fileInfo) {
        var format = getOfficeFormat(fileInfo);
        if (format === 'online') {
            renderOfficeConsent(body, fileInfo);
            return;
        }
        if (format === 'unsupported') {
            showError(body, '此格式暂不支持在线预览，请下载原文件后本地打开。');
            return;
        }
        if (typeof global.Worker !== 'function') {
            showError(body, '此浏览器不支持本地文档解析 Worker，请下载原文件。');
            return;
        }
        fetchFileBytes(previewUrlOf(fileInfo), MAX_OFFICE_BYTES).then(function (bytes) {
            if (!body.isConnected) return;
            var worker = new global.Worker('/js/document-office-worker.js');
            var timeout = null;
            var requestId = 0;
            var stopped = false;
            function stop() {
                stopped = true;
                clearTimeout(timeout);
                worker.terminate();
            }
            modalCleanups.push(stop);
            function send(message, transfer) {
                if (stopped) return;
                message.id = ++requestId;
                clearTimeout(timeout);
                timeout = setTimeout(function () {
                    stop();
                    if (body.isConnected) showError(body, '文档解析超过 15 秒，已停止以保护浏览器。请下载原文件。');
                }, PARSE_TIMEOUT_MS);
                worker.postMessage(message, transfer || []);
            }
            worker.onmessage = function (event) {
                if (stopped || !body.isConnected || event.data.id !== requestId) return;
                clearTimeout(timeout);
                if (event.data.type === 'error') {
                    stop();
                    showError(body, '本地预览失败：' + event.data.message + '。请下载原文件。');
                } else if (event.data.type === 'docx') {
                    stop();
                    renderDocxFrame(body, event.data.buffer);
                } else if (event.data.type === 'sheet') {
                    renderWorkbookSheet(body, event.data, function (name) { send({ type: 'sheet', sheet: name }); });
                }
            };
            worker.onerror = function () {
                stop();
                if (body.isConnected) showError(body, '本地解析库加载失败，请检查静态资源部署或下载原文件。');
            };
            send({ type: 'open', format: format, buffer: bytes.buffer }, [bytes.buffer]);
        }).catch(function (error) {
            if (body.isConnected && error.name !== 'AbortError') showError(body, '加载失败：' + error.message + '。可下载原文件。');
        });
    }

    function renderDocxFrame(body, buffer) {
        setBodyContent(body,
            '<div class="doc-preview-hint">DOCX 在本地隔离环境中渲染，文件不会发送给第三方。宏、HTML 附件、外链和嵌入字体不执行；复杂排版可能与 Office 不同。</div>');
        var frame = document.createElement('iframe');
        frame.className = 'doc-preview-frame';
        frame.title = '本地 DOCX 预览';
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.referrerPolicy = 'no-referrer';
        var sent = false;
        var timeout = setTimeout(function () {
            cleanup();
            if (body.isConnected) showError(body, 'DOCX 渲染超时，请下载原文件。');
        }, PARSE_TIMEOUT_MS);
        function cleanup() {
            clearTimeout(timeout);
            global.removeEventListener('message', handleMessage);
        }
        function handleMessage(event) {
            if (event.source !== frame.contentWindow || event.data?.source !== 'doc-preview-docx') return;
            if (event.data.type === 'ready' && !sent) {
                sent = true;
                frame.contentWindow.postMessage({ source: 'doc-preview-host', type: 'render', buffer: buffer }, '*', [buffer]);
                buffer = null;
            } else if (event.data.type === 'rendered') {
                cleanup();
            } else if (event.data.type === 'error') {
                cleanup();
                if (body.isConnected) showError(body, 'DOCX 预览失败：' + event.data.message + '。请下载原文件。');
            }
        }
        modalCleanups.push(cleanup);
        global.addEventListener('message', handleMessage);
        frame.src = '/document-preview.html';
        body.appendChild(frame);
    }

    function renderWorkbookSheet(body, sheet, selectSheet) {
        body.innerHTML = '';
        var hint = document.createElement('div');
        hint.className = 'doc-preview-hint';
        hint.textContent = '表格在本地 Worker 中解析，不执行宏或公式，最多预览每表前 300 行、50 列（40 个工作表）。图表、复杂格式请下载查看。';
        body.appendChild(hint);
        var controls = document.createElement('div');
        controls.className = 'doc-preview-sheet-controls';
        var label = document.createElement('label');
        label.textContent = '工作表 ';
        var select = document.createElement('select');
        select.setAttribute('aria-label', '选择工作表');
        sheet.sheets.forEach(function (name) {
            var option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            option.selected = name === sheet.sheet;
            select.appendChild(option);
        });
        select.addEventListener('change', function () { select.disabled = true; selectSheet(select.value); });
        label.appendChild(select);
        controls.appendChild(label);
        if (sheet.limited) {
            var limited = document.createElement('span');
            limited.textContent = '内容已按预览限额截断';
            controls.appendChild(limited);
        }
        body.appendChild(controls);
        var scroll = document.createElement('div');
        scroll.className = 'doc-preview-sheet-scroll';
        var table = document.createElement('table');
        table.className = 'doc-preview-sheet';
        var thead = document.createElement('thead');
        var header = document.createElement('tr');
        ['#'].concat(sheet.columns).forEach(function (name) {
            var cell = document.createElement('th');
            cell.scope = 'col';
            cell.textContent = name;
            header.appendChild(cell);
        });
        thead.appendChild(header);
        table.appendChild(thead);
        var tbody = document.createElement('tbody');
        sheet.rows.forEach(function (values, index) {
            var row = document.createElement('tr');
            var number = document.createElement('th');
            number.scope = 'row';
            number.textContent = String(index + 1);
            row.appendChild(number);
            values.forEach(function (value) {
                var cell = document.createElement('td');
                cell.textContent = value;
                row.appendChild(cell);
            });
            tbody.appendChild(row);
        });
        table.appendChild(tbody);
        scroll.appendChild(table);
        body.appendChild(scroll);
    }

    function canShareWithOffice(url) {
        var parsed = safeFileUrl(url);
        if (!parsed || parsed.protocol !== 'https:' || parsed.hash || /^\/temp\//.test(parsed.pathname)) return false;
        var host = parsed.hostname.toLowerCase();
        if (host.indexOf('.') === -1 || /(^|\.)(localhost|local|internal|test|invalid)$/.test(host)
            || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.indexOf(':') !== -1) return false;
        var allowed = true;
        parsed.searchParams.forEach(function (value, key) {
            if (key !== 'preview' || value !== '1') allowed = false;
        });
        return allowed;
    }

    function renderOfficeConsent(body, fileInfo) {
        var url = previewUrlOf(fileInfo);
        setBodyContent(body, '<div class="doc-preview-consent"><p>此格式需要 Microsoft Office Online 预览。只有你明确同意后，公开文件 URL 和文件内容才会交给 Microsoft；微软不携带本站登录 Cookie，私密文件无法使用此服务。</p></div>');
        var consent = body.querySelector('.doc-preview-consent');
        if (!canShareWithOffice(url)) {
            var warning = document.createElement('p');
            warning.textContent = '临时/带凭据链接、内网地址或不安全 URL 不会发送给第三方。请下载原文件后本地查看。';
            consent.appendChild(warning);
            return;
        }
        var button = document.createElement('button');
        button.className = 'doc-preview-open-btn';
        button.textContent = '我同意 Microsoft 获取公开文件并预览';
        button.addEventListener('click', function () {
            button.disabled = true;
            button.textContent = '确认文件可匿名访问...';
            headFile(url, 'omit').then(function (response) {
                if (!body.isConnected) return;
                if (/text\/html/i.test(response.headers.get('Content-Type') || '')) throw new Error('匿名请求返回登录页面');
                var viewerUrl = 'https://view.officeapps.live.com/op/embed.aspx?src=' + encodeURIComponent(url);
                setBodyContent(body, '<div class="doc-preview-hint">已按你的授权将公开文件交给 Microsoft。预览失败可能是微软服务、文件大小或格式限制，请下载原文件。</div>' +
                    '<iframe class="doc-preview-frame" referrerpolicy="no-referrer" src="' + escapeHtml(viewerUrl) + '" title="Microsoft Office 文档预览"></iframe>');
            }).catch(function (error) {
                if (body.isConnected) showError(body, '文件不能匿名访问或服务不可用：' + error.message + '。未向 Microsoft 发送链接，请下载原文件。');
            });
        });
        consent.appendChild(button);
    }

    // Markdown is parsed locally and sanitized in an inert template before mounting.
    function renderMarkdownPreview(body, fileInfo) {
        fetchFileText(previewUrlOf(fileInfo)).then(function (text) {
            loadMarked(function (parseFn) {
                if (!body.isConnected) return;
                if (parseFn) {
                    var rendered = sanitizeMarkdown(parseFn(text), previewUrlOf(fileInfo));
                    body.innerHTML = '';
                    var content = document.createElement('div');
                    content.className = 'doc-preview-markdown';
                    content.appendChild(rendered);
                    body.appendChild(content);
                } else {
                    showToast('Markdown 渲染库加载失败，已降级为纯文本显示', 'warning');
                    renderPlainText(body, text);
                }
            });
        }).catch(function (err) {
            if (body.isConnected && err.name !== 'AbortError') showError(body, '加载失败：' + err.message);
        });
    }

    // 文本/代码：有界纯文本显示，JSON 自动格式化
    function renderTextPreview(body, fileInfo) {
        fetchFileText(previewUrlOf(fileInfo)).then(function (text) {
            if (!body.isConnected) return;
            var ext = getExtension(fileInfo.fileName || fileInfo.fileId);
            if (ext === 'json') {
                try {
                    text = JSON.stringify(JSON.parse(text), null, 2);
                } catch (e) { /* 非合法 JSON，按原样显示 */ }
            }
            renderPlainText(body, text);
        }).catch(function (err) {
            if (body.isConnected && err.name !== 'AbortError') showError(body, '加载失败：' + err.message);
        });
    }

    function renderPlainText(body, text) {
        setBodyContent(
            body,
            '<pre class="doc-preview-text">' + escapeHtml(text) + '</pre>'
        );
    }

    // ==================== 文件内容获取 ====================

    function fileRequest(url, options) {
        if (!originalFetch) {
            return Promise.reject(new Error('当前环境不支持 fetch'));
        }
        if (!safeFileUrl(url)) return Promise.reject(new Error('无效的文件链接'));
        var controller = typeof global.AbortController === 'function' ? new global.AbortController() : null;
        var timedOut = false;
        var timeout = controller ? setTimeout(function () { timedOut = true; controller.abort(); }, FILE_TIMEOUT_MS) : null;
        if (controller) modalCleanups.push(function () { clearTimeout(timeout); controller.abort(); });
        return originalFetch(url, Object.assign({
            credentials: 'same-origin', redirect: 'error', referrerPolicy: 'same-origin',
            signal: controller ? controller.signal : undefined,
        }, options || {})).then(function (res) {
            clearTimeout(timeout);
            if (!res.ok) {
                if (res.status === 401 || res.status === 403) throw new Error('文件需要登录或无权限访问');
                throw new Error('HTTP ' + res.status);
            }
            return res;
        }).catch(function (error) {
            clearTimeout(timeout);
            if (timedOut) throw new Error('获取文件响应超过 30 秒，请下载原文件');
            throw error;
        });
    }

    function headFile(url, credentials) {
        return fileRequest(url, { method: 'HEAD', credentials: credentials, cache: 'no-store',
            referrerPolicy: credentials === 'omit' ? 'no-referrer' : 'same-origin' });
    }

    async function readBoundedResponse(response, limit) {
        var claimed = Number(response.headers.get('Content-Length'));
        if (claimed > limit) {
            if (response.body) await response.body.cancel();
            throw new Error('文件超过本地预览大小上限（' + (limit / 1024 / 1024) + ' MiB）');
        }
        if (!response.body || !response.body.getReader) {
            var buffer = new Uint8Array(await response.arrayBuffer());
            if (buffer.length > limit) throw new Error('文件超过本地预览大小上限');
            return buffer;
        }
        var reader = response.body.getReader();
        var chunks = [];
        var total = 0;
        var timedOut = false;
        var timeout = setTimeout(function () {
            timedOut = true;
            Promise.resolve(reader.cancel()).catch(function () { /* already cancelled */ });
        }, FILE_TIMEOUT_MS);
        try {
            while (true) {
                var result = await reader.read();
                if (result.done) break;
                total += result.value.byteLength;
                if (total > limit) {
                    await reader.cancel();
                    throw new Error('文件超过本地预览大小上限（' + (limit / 1024 / 1024) + ' MiB）');
                }
                chunks.push(result.value);
            }
            if (timedOut) throw new Error('文件读取超过 30 秒，请下载原文件');
        } finally { clearTimeout(timeout); reader.releaseLock(); }
        var bytes = new Uint8Array(total);
        var offset = 0;
        chunks.forEach(function (chunk) { bytes.set(chunk, offset); offset += chunk.length; });
        return bytes;
    }

    function fetchFileBytes(url, limit) {
        return fileRequest(url).then(function (res) { return readBoundedResponse(res, limit); });
    }

    function fetchFileText(url) {
        return fetchFileBytes(url, MAX_TEXT_BYTES).then(function (bytes) { return new TextDecoder('utf-8').decode(bytes); });
    }

    function sanitizeMarkdown(html, baseUrl) {
        var template = document.createElement('template');
        template.innerHTML = html;
        var allowed = /^(H[1-6]|P|BR|HR|PRE|CODE|BLOCKQUOTE|UL|OL|LI|STRONG|EM|DEL|S|TABLE|THEAD|TBODY|TR|TH|TD|A)$/;
        template.content.querySelectorAll('*').forEach(function (node) {
            if (node.tagName === 'IMG') {
                node.replaceWith(document.createTextNode(node.getAttribute('alt') || '[图片已禁用]'));
                return;
            }
            if (!allowed.test(node.tagName)) {
                node.replaceWith(document.createTextNode(node.textContent || ''));
                return;
            }
            var href = node.tagName === 'A' ? node.getAttribute('href') : null;
            var title = node.getAttribute('title');
            Array.from(node.attributes).forEach(function (attribute) { node.removeAttribute(attribute.name); });
            if (title) node.setAttribute('title', title);
            if (href) {
                try {
                    var target = new URL(href, baseUrl || global.location.origin);
                    if (/^(https?:|mailto:)$/.test(target.protocol) && !target.username && !target.password) {
                        node.setAttribute('href', target.href);
                        node.setAttribute('rel', 'noopener noreferrer');
                        node.setAttribute('target', '_blank');
                    }
                } catch (e) { /* unsafe links remain plain text */ }
            }
        });
        return template.content;
    }

    // ==================== marked.js 本地懒加载 ====================

    var markedState = 'idle'; // idle | loading | ready | failed
    var markedQueue = [];

    function loadMarked(callback) {
        if (global.marked && typeof global.marked.parse === 'function') {
            markedState = 'ready';
            callback(global.marked.parse.bind(global.marked));
            return;
        }
        markedQueue.push(callback);
        if (markedState === 'loading' || markedState === 'ready') return;
        if (markedState === 'failed') {
            flushMarkedQueue(null);
            return;
        }
        markedState = 'loading';
        tryLoadMarkedFromCdn(0);
    }

    function tryLoadMarkedFromCdn(index) {
        if (index >= MARKED_SOURCES.length) {
            markedState = 'failed';
            flushMarkedQueue(null);
            return;
        }
        var script = document.createElement('script');
        script.src = MARKED_SOURCES[index];
        script.async = true;
        script.onload = function () {
            if (global.marked && typeof global.marked.parse === 'function') {
                markedState = 'ready';
                flushMarkedQueue(global.marked.parse.bind(global.marked));
            } else {
                script.remove();
                tryLoadMarkedFromCdn(index + 1);
            }
        };
        script.onerror = function () {
            script.remove();
            tryLoadMarkedFromCdn(index + 1);
        };
        var timeout = setTimeout(function () {
            if (markedState === 'loading') script.onerror();
        }, 10000);
        script.addEventListener('load', function () { clearTimeout(timeout); });
        script.addEventListener('error', function () { clearTimeout(timeout); });
        document.head.appendChild(script);
    }

    function flushMarkedQueue(parseFn) {
        var queue = markedQueue.splice(0);
        for (var i = 0; i < queue.length; i++) {
            try {
                queue[i](parseFn);
            } catch (e) { /* ignore */ }
        }
    }

    function resolvePreviewCategory(fileInfo) {
        var category = getDocCategory(fileInfo);
        if (category) return Promise.resolve(category);
        return headFile(previewUrlOf(fileInfo), 'same-origin').then(function (response) {
            fileInfo.mimeType = response.headers.get('Content-Type') || fileInfo.mimeType;
            var disposition = response.headers.get('Content-Disposition') || '';
            var encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i);
            var plainName = disposition.match(/filename="([^"]*)"/i);
            if (encodedName) {
                try { fileInfo.fileName = decodeURIComponent(encodedName[1]); } catch (e) { /* keep dialog name */ }
            } else if (plainName) fileInfo.fileName = plainName[1];
            return getDocCategory(fileInfo);
        });
    }

    // ==================== 按钮注入 ====================

    function injectPreviewButton(dialogEl) {
        var actionsEl = dialogEl.querySelector('.detail-actions');
        if (!actionsEl) return;
        if (actionsEl.hasAttribute(INJECTED_FLAG)) return;
        if (actionsEl.querySelector('.doc-preview-trigger-btn')) return;

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'el-button el-button--primary el-button--small is-round detail-action doc-preview-trigger-btn';
        btn.setAttribute(INJECTED_FLAG, 'true');
        btn.innerHTML = '<span style="margin-right:3px;">📄</span> 文档预览';
        btn.style.cssText = 'margin-left:0!important;';

        btn.addEventListener('click', function () {
            var fileInfo = extractFileUrlFromDialog(dialogEl);
            if (!fileInfo) {
                showToast('无法识别当前文件，请稍后重试', 'error');
                return;
            }
            btn.disabled = true;
            resolvePreviewCategory(fileInfo).then(function (category) {
                if (!category) {
                    var ext = getExtension(fileInfo.fileName || fileInfo.fileId);
                    showToast(ext ? '暂不支持 .' + ext + ' 格式的在线预览，可直接下载查看' : '未识别到可预览的文件类型，请下载查看', 'warning');
                    return;
                }
                openPreviewModal(fileInfo, category);
            }).catch(function (error) {
                showToast('无法获取文件类型：' + error.message, 'error');
            }).finally(function () { btn.disabled = false; });
        });

        actionsEl.appendChild(btn);
        actionsEl.setAttribute(INJECTED_FLAG, 'true');
    }

    // ==================== MutationObserver ====================

    function collectMatching(root, selector) {
        var matches = [];
        var add = function (element) {
            if (element && matches.indexOf(element) === -1) matches.push(element);
        };
        if (!root || root.nodeType === 9) {
            document.querySelectorAll(selector).forEach(add);
            return matches;
        }
        if (root.nodeType !== 1) return matches;
        if (root.matches && root.matches(selector)) add(root);
        if (root.closest) add(root.closest(selector));
        if (root.querySelectorAll) root.querySelectorAll(selector).forEach(add);
        return matches;
    }

    function scanForDetailDialog(roots) {
        var scanRoots = roots && roots.length ? roots : [document];
        var dialogs = [];
        scanRoots.forEach(function (root) {
            collectMatching(root, '.el-dialog').forEach(function (dialog) {
                if (dialogs.indexOf(dialog) === -1) dialogs.push(dialog);
            });
        });
        dialogs.forEach(function (dialog) {
            var titleEl = dialog.querySelector('.el-dialog__title');
            if (titleEl && titleEl.textContent.trim() === DIALOG_TITLE) {
                injectPreviewButton(dialog);
            }
        });
    }

    function attachObserver() {
        if (!global.MutationObserver || !document.documentElement) return;

        var scheduled = false;
        var pendingRoots = [];
        var scheduleScan = function (roots) {
            if (roots && roots.length) {
                roots.forEach(function (root) {
                    if (pendingRoots.indexOf(root) === -1) pendingRoots.push(root);
                });
            }
            if (scheduled) return;
            scheduled = true;
            var run = function () {
                scheduled = false;
                var rootsToScan = pendingRoots;
                pendingRoots = [];
                scanForDetailDialog(rootsToScan);
            };
            if (typeof global.requestAnimationFrame === 'function') {
                global.requestAnimationFrame(run);
            } else {
                setTimeout(run, 16);
            }
        };

        new global.MutationObserver(function (mutations) {
            var roots = [];
            mutations.forEach(function (mutation) {
                if (!mutation.addedNodes || !mutation.addedNodes.length) return;
                Array.prototype.forEach.call(mutation.addedNodes, function (node) {
                    if (node && node.nodeType === 1 && roots.indexOf(node) === -1) roots.push(node);
                });
            });
            if (roots.length) scheduleScan(roots);
        }).observe(document.documentElement, {
            childList: true,
            subtree: true,
        });
    }

    // ==================== 启动 ====================

    function init() {
        injectStyles();
        attachObserver();
        setTimeout(scanForDetailDialog, 0);
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', scanForDetailDialog);
        }
    }

    init();

    global.DocumentPreviewEnhancer = {
        extractFileUrlFromDialog: extractFileUrlFromDialog,
        getDocCategory: getDocCategory,
        getOfficeFormat: getOfficeFormat,
        getExtension: getExtension,
        openPreviewModal: openPreviewModal,
        closeModal: closeModal,
        withIntent: withIntent,
        canShareWithOffice: canShareWithOffice,
        resolvePreviewCategory: resolvePreviewCategory,
        readBoundedResponse: readBoundedResponse,
        sanitizeMarkdown: sanitizeMarkdown,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
