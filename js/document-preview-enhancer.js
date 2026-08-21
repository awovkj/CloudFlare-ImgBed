/**
 * 文档在线预览增强脚本
 *
 * 在文件详情对话框中注入"文档预览"按钮，支持：
 * - PDF：浏览器内置查看器（iframe 嵌入）
 * - Office（doc/docx/xls/xlsx/ppt/pptx）：Microsoft Office Online 预览
 * - Markdown（md/markdown）：marked.js 渲染（CDN 懒加载，失败降级纯文本）
 * - 文本/代码（txt/log/json/xml/yml/csv/js/py 等）：纯文本 / JSON 格式化显示
 *
 * 设计原则：
 * - 纯原生 JS 实现，不依赖 Vue/Element Plus 内部 API
 * - 通过 MutationObserver 监听文件详情对话框出现（与 temp-link-enhancer 同模式）
 * - 预览请求复用页面同源 Cookie，与图片/视频预览行为一致
 * - Markdown 渲染前先整体 HTML 转义，防止存储型 XSS
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
    var MARKED_CDNS = [
        'https://cdn.jsdelivr.net/npm/marked@11.2.0/marked.min.js',
        'https://unpkg.com/marked@11.2.0/marked.min.js',
    ];

    var originalFetch = global.fetch ? global.fetch.bind(global) : null;
    // 当前预览模态框的全局键盘监听引用，关闭时同步释放。
    var modalEscHandler = null;

    // ==================== 类型识别 ====================

    var EXT_CATEGORY_MAP = {};
    function registerCategory(category, extensions) {
        for (var i = 0; i < extensions.length; i++) {
            EXT_CATEGORY_MAP[extensions[i]] = category;
        }
    }
    registerCategory('pdf', ['pdf']);
    registerCategory('office', ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'wps', 'et', 'dps']);
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

    function getExtension(fileId) {
        if (!fileId) return null;
        var name = fileId.split('/').pop() || fileId;
        var dot = name.lastIndexOf('.');
        if (dot === -1 || dot === name.length - 1) return null;
        return name.slice(dot + 1).toLowerCase();
    }

    function getDocCategory(fileId) {
        var ext = getExtension(fileId);
        return ext ? (EXT_CATEGORY_MAP[ext] || null) : null;
    }

    // ==================== 对话框信息提取 ====================

    // 提取当前详情对话框中文件的访问 URL 与 fileId
    // 策略与 temp-link-enhancer 保持一致：预览元素 src → 链接输入框 → el-image
    function extractFileUrlFromDialog(dialogEl) {
        var candidates = [];
        var previewImg = dialogEl.querySelector('.image-preview');
        if (previewImg && previewImg.src) candidates.push(previewImg.src);
        var previewVideo = dialogEl.querySelector('.video-preview');
        if (previewVideo && previewVideo.src) candidates.push(previewVideo.src);
        var previewAudio = dialogEl.querySelector('.audio-preview');
        if (previewAudio && previewAudio.src) candidates.push(previewAudio.src);

        var inputs = dialogEl.querySelectorAll('.el-tabs .el-input__inner, .el-tabs input');
        for (var i = 0; i < inputs.length; i++) {
            var val = inputs[i].value || '';
            if (val.indexOf('/file/') !== -1) candidates.push(val);
        }

        var elImageImg = dialogEl.querySelector('.el-image img, .el-image__inner');
        if (elImageImg && elImageImg.src) candidates.push(elImageImg.src);

        for (var j = 0; j < candidates.length; j++) {
            var fileId = parseFileIdFromUrl(candidates[j]);
            if (fileId) {
                var absoluteUrl = null;
                try {
                    absoluteUrl = new URL(candidates[j], global.location.origin).href;
                } catch (e) { /* ignore */ }
                if (absoluteUrl) return { url: absoluteUrl, fileId: fileId };
            }
        }
        return null;
    }

    function parseFileIdFromUrl(url) {
        try {
            var u = new URL(url, global.location.origin);
            var match = u.pathname.match(/^\/file\/(.+)$/);
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
            var u = new URL(url, global.location.origin);
            if (intent === 'download') {
                u.searchParams.delete('preview');
                u.searchParams.set('download', '1');
            } else {
                u.searchParams.delete('download');
                u.searchParams.set('preview', '1');
            }
            return u.href;
        } catch (e) {
            // URL 解析失败时退回原始链接，至少不影响可用性
            return url;
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
        if (existing) existing.remove();
    }

    function openPreviewModal(fileInfo, category) {
        closeModal(); // 确保只有一个模态框

        var fileName = getDisplayName(fileInfo.fileId);
        var categoryLabel = CATEGORY_LABELS[category] || '文档';

        var overlay = document.createElement('div');
        overlay.className = 'doc-preview-overlay';
        overlay.id = MODAL_ID;

        var modal = document.createElement('div');
        modal.className = 'doc-preview-modal';
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
            global.open(previewUrlOf(fileInfo), '_blank');
        });
        overlay.querySelector('.doc-preview-download-btn').addEventListener('click', function () {
            var link = document.createElement('a');
            link.href = withIntent(fileInfo.url, 'download');
            link.rel = 'noopener';
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
            }
        };
        document.addEventListener('keydown', modalEscHandler);

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
        setBodyContent(
            body,
            '<iframe class="doc-preview-frame" src="' + escapeHtml(previewUrlOf(fileInfo)) + '" title="PDF 预览"></iframe>'
        );
    }

    // Office：Microsoft Office Online 预览（文件需可公网访问）
    function renderOfficePreview(body, fileInfo) {
        var viewerUrl = 'https://view.officeapps.live.com/op/embed.aspx?src=' + encodeURIComponent(previewUrlOf(fileInfo));
        body.innerHTML =
            '<div class="doc-preview-hint">预览由 Microsoft Office Online 提供，需要文件可被公网访问；若站点开启了登录校验、部署在内网或 localhost，微软服务器取不到文件，请改用"下载"后本地打开。</div>' +
            '<iframe class="doc-preview-frame" src="' + escapeHtml(viewerUrl) + '" title="Office 文档预览"></iframe>';
    }

    // Markdown：fetch 内容 + marked.js 渲染，失败降级纯文本（完整内容，不截断）
    function renderMarkdownPreview(body, fileInfo) {
        fetchFileText(previewUrlOf(fileInfo)).then(function (text) {
            loadMarked(function (parseFn) {
                if (parseFn) {
                    // 先整体转义再解析，防止文件内容中的内联 HTML/脚本执行
                    var rendered = parseFn(escapeHtml(text));
                    setBodyContent(body, '<div class="doc-preview-markdown">' + rendered + '</div>');
                } else {
                    showToast('Markdown 渲染库加载失败，已降级为纯文本显示', 'warning');
                    renderPlainText(body, text);
                }
            });
        }).catch(function (err) {
            showError(body, '加载失败：' + err.message);
        });
    }

    // 文本/代码：纯文本完整显示，JSON 自动格式化
    function renderTextPreview(body, fileInfo) {
        fetchFileText(previewUrlOf(fileInfo)).then(function (text) {
            var ext = getExtension(fileInfo.fileId);
            if (ext === 'json') {
                try {
                    text = JSON.stringify(JSON.parse(text), null, 2);
                } catch (e) { /* 非合法 JSON，按原样显示 */ }
            }
            renderPlainText(body, text);
        }).catch(function (err) {
            showError(body, '加载失败：' + err.message);
        });
    }

    function renderPlainText(body, text) {
        setBodyContent(
            body,
            '<pre class="doc-preview-text">' + escapeHtml(text) + '</pre>'
        );
    }

    // ==================== 文件内容获取 ====================

    function fetchFileText(url) {
        if (!originalFetch) {
            return Promise.reject(new Error('当前环境不支持 fetch'));
        }
        return originalFetch(url, { credentials: 'include' }).then(function (res) {
            if (!res.ok) {
                throw new Error('HTTP ' + res.status);
            }
            var contentType = (res.headers.get('Content-Type') || '').toLowerCase();
            // 站点开启认证时，/file/ 可能 302 到登录页（最终 200 text/html）
            if (contentType.indexOf('text/html') !== -1) {
                throw new Error('文件需要登录或无权限访问');
            }
            return res.text();
        });
    }

    // ==================== marked.js 懒加载 ====================

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
        if (index >= MARKED_CDNS.length) {
            markedState = 'failed';
            flushMarkedQueue(null);
            return;
        }
        var script = document.createElement('script');
        script.src = MARKED_CDNS[index];
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

    // ==================== 按钮注入 ====================

    function injectPreviewButton(dialogEl) {
        var actionsEl = dialogEl.querySelector('.detail-actions');
        if (!actionsEl) return;
        if (actionsEl.hasAttribute(INJECTED_FLAG)) return;
        if (actionsEl.querySelector('.doc-preview-trigger-btn')) return;

        var btn = document.createElement('button');
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
            var category = getDocCategory(fileInfo.fileId);
            if (!category) {
                var ext = getExtension(fileInfo.fileId);
                showToast(
                    ext
                        ? '暂不支持 .' + ext + ' 格式的在线预览，可直接下载查看'
                        : '未识别到文件扩展名，无法在线预览',
                    'warning'
                );
                return;
            }
            openPreviewModal(fileInfo, category);
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
        openPreviewModal: openPreviewModal,
        withIntent: withIntent,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
