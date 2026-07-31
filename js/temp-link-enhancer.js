/**
 * 临时链接增强脚本
 *
 * 在文件详情对话框中注入"临时链接"按钮，支持：
 * - 生成临时链接（3小时 / 1天 / 7天）
 * - 查看已有临时链接
 * - 复制链接
 * - 手动销毁链接
 * - 过期后链接自动失效
 *
 * 设计原则：
 * - 纯原生 JS 实现，不依赖 Vue/Element Plus 内部 API
 * - 通过 MutationObserver 监听文件详情对话框出现
 * - 复用页面已有的认证（session cookie + 拦截到的 Authorization 头）
 */
(function attachTempLinkEnhancer(global) {
    'use strict';

    var API_BASE = '/api/manage/temp-link/';
    var INJECTED_FLAG = 'data-temp-link-injected';
    var DIALOG_TITLE = '文件详情';

    // 拦截到的 Authorization 头（来自 fetchWithAuth）
    var cachedAuthHeader = null;
    // 保存原始 fetch 引用，避免递归调用
    var originalFetch = global.fetch.bind(global);

    // ==================== 认证拦截 ====================

    function patchFetch() {
        if (global.fetch.__tempLinkPatched) return;
        global.fetch = function (input, init) {
            try {
                var url = typeof input === 'string' ? input : (input && input.url) || '';
                var headers = (init && init.headers) || (input && input.headers) || null;
                if (url.indexOf('/api/manage/') !== -1 && headers) {
                    var auth = null;
                    if (headers instanceof Headers) {
                        auth = headers.get('Authorization');
                    } else if (typeof headers === 'object') {
                        auth = headers['Authorization'] || headers['authorization'];
                    }
                    if (auth) cachedAuthHeader = auth;
                }
            } catch (e) { /* ignore */ }
            return originalFetch.apply(this, arguments);
        };
        global.fetch.__tempLinkPatched = true;
    }

    function authedFetch(url, options) {
        options = options || {};
        options.credentials = 'include';
        options.headers = Object.assign({}, options.headers || {});
        if (cachedAuthHeader) {
            options.headers['Authorization'] = cachedAuthHeader;
        }
        return originalFetch(url, options);
    }

    // ==================== 工具函数 ====================

    function encodeFileIdForUrl(fileId) {
        // 与前端其他 API 调用（如 /api/manage/metadata/${fileId}）保持一致：
        // 直接使用原始 fileId 拼接 URL，fileId 中的 / 会被路由正则 (.+) 正确捕获。
        // 后端通过 decodeURIComponent + split(',').join('/') 还原。
        return fileId;
    }

    function extractFileIdFromDialog(dialogEl) {
        // 策略 1: 从预览元素的 src 提取
        var previewImg = dialogEl.querySelector('.image-preview');
        if (previewImg && previewImg.src) {
            var id = parseFileIdFromUrl(previewImg.src);
            if (id) return id;
        }
        var previewVideo = dialogEl.querySelector('.video-preview');
        if (previewVideo && previewVideo.src) {
            var id2 = parseFileIdFromUrl(previewVideo.src);
            if (id2) return id2;
        }
        var previewAudio = dialogEl.querySelector('.audio-preview');
        if (previewAudio && previewAudio.src) {
            var id3 = parseFileIdFromUrl(previewAudio.src);
            if (id3) return id3;
        }

        // 策略 2: 从"原始链接"输入框提取
        var inputs = dialogEl.querySelectorAll('.el-tabs .el-input__inner, .el-tabs input');
        for (var i = 0; i < inputs.length; i++) {
            var val = inputs[i].value || '';
            if (val.indexOf('/file/') !== -1) {
                var id4 = parseFileIdFromUrl(val);
                if (id4) return id4;
            }
        }

        // 策略 3: 从 el-image 的 src 属性提取（懒加载场景）
        var elImageImg = dialogEl.querySelector('.el-image img, .el-image__inner');
        if (elImageImg && elImageImg.src) {
            var id5 = parseFileIdFromUrl(elImageImg.src);
            if (id5) return id5;
        }

        return null;
    }

    function parseFileIdFromUrl(url) {
        try {
            var u = new URL(url, global.location.origin);
            var match = u.pathname.match(/^\/file\/(.+)$/);
            if (match) {
                // fileId 中的 , 还原为 /
                return decodeURIComponent(match[1]).split(',').join('/');
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    function formatRemainingTime(expiresAt) {
        var now = Date.now();
        var diff = expiresAt - now;
        if (diff <= 0) return '已过期';
        var seconds = Math.floor(diff / 1000);
        var minutes = Math.floor(seconds / 60);
        var hours = Math.floor(minutes / 60);
        var days = Math.floor(hours / 24);
        if (days > 0) return days + '天' + (hours % 24) + '小时';
        if (hours > 0) return hours + '小时' + (minutes % 60) + '分钟';
        if (minutes > 0) return minutes + '分钟';
        return seconds + '秒';
    }

    function formatExpiresTime(expiresAt) {
        try {
            return new Date(expiresAt).toLocaleString('zh-CN');
        } catch (e) {
            return '未知';
        }
    }

    function showToast(message, type) {
        var colors = {
            success: '#67c23a',
            error: '#f56c6c',
            info: '#909399',
            warning: '#e6a23c',
        };
        var toast = document.createElement('div');
        toast.className = 'temp-link-toast';
        toast.textContent = message;
        toast.style.cssText =
            'position:fixed;top:20px;left:50%;transform:translateX(-50%);' +
            'background:' + (colors[type] || colors.info) + ';color:#fff;padding:10px 20px;' +
            'border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:10000;' +
            'font-size:14px;font-family:inherit;animation:tempLinkToastIn 0.3s ease;';
        document.body.appendChild(toast);
        setTimeout(function () {
            toast.style.transition = 'opacity 0.3s ease';
            toast.style.opacity = '0';
            setTimeout(function () { toast.remove(); }, 300);
        }, 2500);
    }

    // ==================== 样式注入 ====================

    function injectStyles() {
        if (document.getElementById('temp-link-enhancer-styles')) return;
        var style = document.createElement('style');
        style.id = 'temp-link-enhancer-styles';
        style.textContent = [
            '@keyframes tempLinkToastIn { from { opacity:0; transform:translate(-50%,-10px); } to { opacity:1; transform:translate(-50%,0); } }',
            '@keyframes tempLinkModalIn { from { opacity:0; transform:translateY(-20px); } to { opacity:1; transform:translateY(0); } }',
            '.temp-link-modal-overlay {',
            '  position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;',
            '  display:flex;align-items:center;justify-content:center;',
            '  animation:tempLinkModalIn 0.2s ease;',
            '}',
            '.temp-link-modal {',
            '  background:var(--el-bg-color,#fff);border-radius:12px;',
            '  box-shadow:0 12px 32px rgba(0,0,0,0.2);',
            '  width:90%;max-width:600px;max-height:85vh;overflow:hidden;',
            '  display:flex;flex-direction:column;',
            '  font-family:inherit;color:var(--el-text-color-primary,inherit);',
            '}',
            '.temp-link-modal-header {',
            '  padding:16px 20px;border-bottom:1px solid var(--el-border-color-lighter,#eee);',
            '  display:flex;justify-content:space-between;align-items:center;',
            '}',
            '.temp-link-modal-title { font-size:16px;font-weight:600; }',
            '.temp-link-modal-close {',
            '  background:none;border:none;font-size:20px;cursor:pointer;',
            '  color:var(--el-text-color-secondary,#909399);padding:4px 8px;border-radius:4px;',
            '}',
            '.temp-link-modal-close:hover { background:var(--el-fill-color-light,#f5f7fa); }',
            '.temp-link-modal-body { padding:20px;overflow-y:auto;flex:1; }',
            '.temp-link-section-title {',
            '  font-size:13px;font-weight:600;color:var(--el-text-color-secondary,#909399);',
            '  margin-bottom:10px;text-transform:uppercase;letter-spacing:0.5px;',
            '}',
            '.temp-link-create-form {',
            '  display:flex;gap:8px;flex-wrap:wrap;align-items:center;',
            '  padding:12px;background:var(--el-fill-color-light,#f5f7fa);border-radius:8px;',
            '  margin-bottom:20px;',
            '}',
            '.temp-link-duration-select {',
            '  padding:6px 12px;border:1px solid var(--el-border-color,#dcdfe6);',
            '  border-radius:6px;background:var(--el-bg-color,#fff);font-size:13px;',
            '  font-family:inherit;color:var(--el-text-color-primary,inherit);cursor:pointer;',
            '}',
            '.temp-link-duration-select:focus { outline:none;border-color:var(--el-color-primary,#409eff); }',
            '.temp-link-create-btn {',
            '  padding:6px 16px;background:var(--el-color-primary,#409eff);color:#fff;',
            '  border:none;border-radius:6px;cursor:pointer;font-size:13px;font-family:inherit;',
            '}',
            '.temp-link-create-btn:hover { opacity:0.9; }',
            '.temp-link-create-btn:disabled { opacity:0.6;cursor:not-allowed; }',
            '.temp-link-list { display:flex;flex-direction:column;gap:10px; }',
            '.temp-link-item {',
            '  padding:12px;border:1px solid var(--el-border-color-lighter,#eee);',
            '  border-radius:8px;display:flex;flex-direction:column;gap:8px;',
            '}',
            '.temp-link-item-url {',
            '  display:flex;gap:8px;align-items:center;',
            '}',
            '.temp-link-item-url-input {',
            '  flex:1;padding:6px 10px;border:1px solid var(--el-border-color,#dcdfe6);',
            '  border-radius:6px;font-size:12px;font-family:monospace;',
            '  background:var(--el-fill-color-blank,#fff);',
            '  color:var(--el-text-color-regular,#606266);min-width:0;',
            '}',
            '.temp-link-item-url-input:focus { outline:none;border-color:var(--el-color-primary,#409eff); }',
            '.temp-link-copy-btn {',
            '  padding:6px 12px;background:var(--el-color-success,#67c23a);color:#fff;',
            '  border:none;border-radius:6px;cursor:pointer;font-size:12px;font-family:inherit;',
            '  white-space:nowrap;',
            '}',
            '.temp-link-copy-btn:hover { opacity:0.9; }',
            '.temp-link-destroy-btn {',
            '  padding:6px 12px;background:var(--el-color-danger,#f56c6c);color:#fff;',
            '  border:none;border-radius:6px;cursor:pointer;font-size:12px;font-family:inherit;',
            '  white-space:nowrap;',
            '}',
            '.temp-link-destroy-btn:hover { opacity:0.9; }',
            '.temp-link-item-meta {',
            '  display:flex;gap:12px;font-size:11px;color:var(--el-text-color-secondary,#909399);',
            '  flex-wrap:wrap;',
            '}',
            '.temp-link-item-meta span { display:inline-flex;align-items:center;gap:3px; }',
            '.temp-link-empty {',
            '  text-align:center;padding:20px;color:var(--el-text-color-secondary,#909399);',
            '  font-size:13px;',
            '}',
            '.temp-link-loading {',
            '  text-align:center;padding:20px;color:var(--el-text-color-secondary,#909399);',
            '}',
            '.temp-link-modal-footer {',
            '  padding:12px 20px;border-top:1px solid var(--el-border-color-lighter,#eee);',
            '  display:flex;justify-content:flex-end;gap:8px;',
            '}',
            '.temp-link-modal-btn {',
            '  padding:6px 16px;border:1px solid var(--el-border-color,#dcdfe6);',
            '  border-radius:6px;cursor:pointer;font-size:13px;font-family:inherit;',
            '  background:var(--el-bg-color,#fff);color:var(--el-text-color-regular,#606266);',
            '}',
            '.temp-link-modal-btn:hover { border-color:var(--el-color-primary,#409eff);color:var(--el-color-primary,#409eff); }',
        ].join('\n');
        document.head.appendChild(style);
    }

    // ==================== 按钮注入 ====================

    function injectTempLinkButton(dialogEl) {
        var actionsEl = dialogEl.querySelector('.detail-actions');
        if (!actionsEl) return;
        if (actionsEl.hasAttribute(INJECTED_FLAG)) return;

        // 检查是否处于编辑模式（编辑模式下不注入）
        var editBtn = actionsEl.querySelector('.temp-link-trigger-btn');
        if (editBtn) return;

        var btn = document.createElement('button');
        btn.className = 'el-button el-button--primary el-button--small is-round detail-action temp-link-trigger-btn';
        btn.setAttribute(INJECTED_FLAG, 'true');
        btn.innerHTML = '<span style="margin-right:3px;">⏱</span> 临时链接';
        btn.style.cssText = 'margin-left:0!important;';

        btn.addEventListener('click', function () {
            var fileId = extractFileIdFromDialog(dialogEl);
            if (!fileId) {
                showToast('无法识别文件 ID，请稍后重试', 'error');
                return;
            }
            openTempLinkModal(fileId);
        });

        actionsEl.appendChild(btn);
        actionsEl.setAttribute(INJECTED_FLAG, 'true');
    }

    // ==================== 模态框 ====================

    function openTempLinkModal(fileId) {
        closeModal(); // 确保只有一个模态框

        var overlay = document.createElement('div');
        overlay.className = 'temp-link-modal-overlay';
        overlay.id = 'temp-link-modal-overlay';

        var modal = document.createElement('div');
        modal.className = 'temp-link-modal';

        modal.innerHTML =
            '<div class="temp-link-modal-header">' +
            '  <span class="temp-link-modal-title">临时链接管理</span>' +
            '  <button class="temp-link-modal-close" title="关闭">&times;</button>' +
            '</div>' +
            '<div class="temp-link-modal-body">' +
            '  <div class="temp-link-section-title">生成新链接</div>' +
            '  <div class="temp-link-create-form">' +
            '    <select class="temp-link-duration-select">' +
            '      <option value="3h">3 小时</option>' +
            '      <option value="1d">1 天</option>' +
            '      <option value="7d">7 天</option>' +
            '    </select>' +
            '    <button class="temp-link-create-btn">生成链接</button>' +
            '  </div>' +
            '  <div class="temp-link-section-title">已有链接</div>' +
            '  <div class="temp-link-list" id="temp-link-list-container">' +
            '    <div class="temp-link-loading">加载中...</div>' +
            '  </div>' +
            '</div>' +
            '<div class="temp-link-modal-footer">' +
            '  <button class="temp-link-modal-btn temp-link-close-btn">关闭</button>' +
            '</div>';

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // 绑定关闭事件
        overlay.querySelector('.temp-link-modal-close').addEventListener('click', closeModal);
        overlay.querySelector('.temp-link-close-btn').addEventListener('click', closeModal);
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) closeModal();
        });

        // 绑定生成链接事件
        var createBtn = overlay.querySelector('.temp-link-create-btn');
        createBtn.addEventListener('click', function () {
            handleCreateTempLink(fileId, overlay);
        });

        // ESC 关闭
        var escHandler = function (e) {
            if (e.key === 'Escape') {
                closeModal();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);

        // 加载已有链接
        loadTempLinks(fileId, overlay);
    }

    function closeModal() {
        var existing = document.getElementById('temp-link-modal-overlay');
        if (existing) existing.remove();
    }

    // ==================== API 调用 ====================

    function loadTempLinks(fileId, overlay) {
        var container = overlay.querySelector('#temp-link-list-container');
        container.innerHTML = '<div class="temp-link-loading">加载中...</div>';

        authedFetch(API_BASE + encodeFileIdForUrl(fileId), {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
        }).then(function (res) {
            return res.json();
        }).then(function (data) {
            if (data && data.success) {
                renderTempLinks(data.links || [], overlay);
            } else {
                container.innerHTML = '<div class="temp-link-empty">加载失败：' + (data && data.message || '未知错误') + '</div>';
            }
        }).catch(function (err) {
            container.innerHTML = '<div class="temp-link-empty">加载失败：' + err.message + '</div>';
        });
    }

    function renderTempLinks(links, overlay) {
        var container = overlay.querySelector('#temp-link-list-container');
        if (!links.length) {
            container.innerHTML = '<div class="temp-link-empty">暂无临时链接，请在上方生成</div>';
            return;
        }

        container.innerHTML = '';
        var list = document.createElement('div');
        list.className = 'temp-link-list';

        links.forEach(function (link) {
            var item = document.createElement('div');
            item.className = 'temp-link-item';

            var now = Date.now();
            var expired = link.expiresAt && now > link.expiresAt;
            var remaining = expired ? '已过期' : formatRemainingTime(link.expiresAt);

            item.innerHTML =
                '<div class="temp-link-item-url">' +
                '  <input class="temp-link-item-url-input" type="text" readonly value="' + escapeHtml(buildTempLinkUrl(link)) + '">' +
                '  <button class="temp-link-copy-btn">复制</button>' +
                '  <button class="temp-link-destroy-btn">销毁</button>' +
                '</div>' +
                '<div class="temp-link-item-meta">' +
                '  <span>⏱ 时长: ' + (link.duration || '-') + '</span>' +
                '  <span>📅 过期: ' + formatExpiresTime(link.expiresAt) + '</span>' +
                '  <span>' + (expired ? '⚠ 已过期' : '⏳ 剩余: ' + remaining) + '</span>' +
                '</div>';

            // 复制按钮
            item.querySelector('.temp-link-copy-btn').addEventListener('click', function () {
                var input = item.querySelector('.temp-link-item-url-input');
                input.select();
                copyToClipboard(input.value);
            });

            // 销毁按钮
            item.querySelector('.temp-link-destroy-btn').addEventListener('click', function () {
                handleDestroyTempLink(link, item);
            });

            list.appendChild(item);
        });

        container.appendChild(list);
    }

    function buildTempLinkUrl(link) {
        return global.location.origin + '/temp/' + link.token;
    }

    function handleCreateTempLink(fileId, overlay) {
        var select = overlay.querySelector('.temp-link-duration-select');
        var createBtn = overlay.querySelector('.temp-link-create-btn');
        var duration = select.value;

        createBtn.disabled = true;
        createBtn.textContent = '生成中...';

        authedFetch(API_BASE + encodeFileIdForUrl(fileId), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ duration: duration }),
        }).then(function (res) {
            return res.json();
        }).then(function (data) {
            if (data && data.success) {
                showToast('临时链接已生成', 'success');
                loadTempLinks(fileId, overlay);
            } else {
                showToast('生成失败：' + (data && data.message || '未知错误'), 'error');
            }
        }).catch(function (err) {
            showToast('生成失败：' + err.message, 'error');
        }).finally(function () {
            createBtn.disabled = false;
            createBtn.textContent = '生成链接';
        });
    }

    function handleDestroyTempLink(link, itemEl) {
        if (!confirm('确定要销毁此临时链接吗？销毁后链接将立即失效。')) return;

        var destroyBtn = itemEl.querySelector('.temp-link-destroy-btn');
        destroyBtn.disabled = true;
        destroyBtn.textContent = '销毁中...';

        authedFetch(API_BASE + encodeFileIdForUrl(link.fileId) + '?token=' + encodeURIComponent(link.token), {
            method: 'DELETE',
        }).then(function (res) {
            return res.json();
        }).then(function (data) {
            if (data && data.success) {
                showToast('临时链接已销毁', 'success');
                itemEl.style.transition = 'opacity 0.3s ease';
                itemEl.style.opacity = '0';
                setTimeout(function () { itemEl.remove(); }, 300);
            } else {
                showToast('销毁失败：' + (data && data.message || '未知错误'), 'error');
                destroyBtn.disabled = false;
                destroyBtn.textContent = '销毁';
            }
        }).catch(function (err) {
            showToast('销毁失败：' + err.message, 'error');
            destroyBtn.disabled = false;
            destroyBtn.textContent = '销毁';
        });
    }

    // ==================== 辅助函数 ====================

    function copyToClipboard(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () {
                showToast('链接已复制到剪贴板', 'success');
            }).catch(function () {
                fallbackCopy(text);
            });
        } else {
            fallbackCopy(text);
        }
    }

    function fallbackCopy(text) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;';
        document.body.appendChild(ta);
        ta.select();
        try {
            document.execCommand('copy');
            showToast('链接已复制到剪贴板', 'success');
        } catch (e) {
            showToast('复制失败，请手动复制', 'error');
        }
        ta.remove();
    }

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ==================== MutationObserver ====================

    function findDetailDialog(root) {
        var dialogs = root.querySelectorAll('.el-dialog');
        for (var i = 0; i < dialogs.length; i++) {
            var titleEl = dialogs[i].querySelector('.el-dialog__title');
            if (titleEl && titleEl.textContent.trim() === DIALOG_TITLE) {
                return dialogs[i];
            }
        }
        return null;
    }

    function scanForDetailDialog() {
        var dialog = findDetailDialog(document);
        if (dialog) {
            injectTempLinkButton(dialog);
        }
    }

    function attachObserver() {
        if (!global.MutationObserver || !document.documentElement) return;

        var scheduled = false;
        var scheduleScan = function () {
            if (scheduled) return;
            scheduled = true;
            var run = function () { scheduled = false; scanForDetailDialog(); };
            if (typeof global.requestAnimationFrame === 'function') {
                global.requestAnimationFrame(run);
            } else {
                setTimeout(run, 16);
            }
        };

        new global.MutationObserver(scheduleScan).observe(document.documentElement, {
            childList: true,
            subtree: true,
        });
    }

    // ==================== 启动 ====================

    function init() {
        injectStyles();
        patchFetch();
        attachObserver();
        // 首次扫描（可能在 DOMContentLoaded 前已有对话框）
        setTimeout(scanForDetailDialog, 0);
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', scanForDetailDialog);
        }
    }

    init();

    global.TempLinkEnhancer = {
        extractFileIdFromDialog: extractFileIdFromDialog,
        openTempLinkModal: openTempLinkModal,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
