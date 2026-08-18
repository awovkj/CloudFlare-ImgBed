/**
 * 目录列表密码门控 - 管理端设置卡片
 *
 * 在管理端"其他设置"页面（特征：包含"音乐播放器"设置卡片）注入原生设置卡片，支持：
 * - 开启/关闭目录列表密码门控
 * - 设置/修改/清除目录密码
 *
 * 后端行为（functions/api/directoryTree.js）：
 * - 启用后，非管理员访问 /api/directoryTree 需携带正确的 X-Directory-Password 头
 * - 上传页/目录选择处会弹出密码解锁输入；手动填写目录路径不受影响
 *
 * 设计原则：
 * - 纯原生 JS，通过 MutationObserver 监听"其他设置"子页出现（SPA 路由切换后重新注入）
 * - POST /api/manage/sysConfig/others 为全量覆盖语义：保存前先 GET 最新配置，
 *   仅修改 directoryList 字段后整体回传，避免破坏 webDAV 等其他配置
 */
(function attachDirectoryGuardSettings(global) {
    'use strict';

    var API_URL = '/api/manage/sysConfig/others';
    var CARD_ID = 'cfbed-directory-guard-card';
    var ANCHOR_TEXT = '音乐播放器';

    // ==================== 工具 ====================

    function toast(message, type) {
        var colors = { success: '#67c23a', error: '#f56c6c', info: '#909399' };
        var el = document.createElement('div');
        el.textContent = message;
        el.style.cssText =
            'position:fixed;top:20px;left:50%;transform:translateX(-50%);' +
            'background:' + (colors[type] || colors.info) + ';color:#fff;' +
            'padding:10px 20px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.15);' +
            'z-index:10001;font-size:14px;font-family:inherit;';
        document.body.appendChild(el);
        setTimeout(function () {
            el.style.transition = 'opacity .3s ease';
            el.style.opacity = '0';
            setTimeout(function () { el.remove(); }, 300);
        }, 2500);
    }

    function authedFetch(url, options) {
        options = options || {};
        options.credentials = 'include';
        options.headers = Object.assign({ Accept: 'application/json' }, options.headers || {});
        return fetch(url, options);
    }

    function loadOthersConfig() {
        return authedFetch(API_URL).then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
        });
    }

    // ==================== 设置卡片 ====================

    function buildCard() {
        var card = document.createElement('div');
        card.id = CARD_ID;
        card.className = 'cfbed-dg-card';
        card.innerHTML =
            '<div class="cfbed-dg-title">目录列表密码门控</div>' +
            '<div class="cfbed-dg-desc">开启后，非管理员在上传页选择目录时需输入密码才能查看已有目录列表；手动输入目录路径不受影响。管理员始终可直接查看。</div>' +
            '<div class="cfbed-dg-row">' +
            '  <label class="cfbed-dg-switch"><input type="checkbox" class="cfbed-dg-enabled"><span>启用目录密码门控</span></label>' +
            '  <span class="cfbed-dg-status"></span>' +
            '</div>' +
            '<div class="cfbed-dg-row">' +
            '  <input type="password" class="cfbed-dg-password" placeholder="设置新密码" autocomplete="new-password">' +
            '</div>' +
            '<div class="cfbed-dg-actions">' +
            '  <button type="button" class="cfbed-dg-btn is-primary cfbed-dg-save">保存设置</button>' +
            '  <button type="button" class="cfbed-dg-btn cfbed-dg-clear">清除密码</button>' +
            '</div>';
        return card;
    }

    function refreshStatus(card) {
        var enabled = card.querySelector('.cfbed-dg-enabled').checked;
        var configured = card.__passwordConfigured === true;
        card.querySelector('.cfbed-dg-status').textContent =
            (enabled ? '已启用' : '未启用') + ' · 密码' + (configured ? '已设置' : '未设置');
    }

    function fillCard(card, config) {
        var dirList = config.directoryList || {};
        card.querySelector('.cfbed-dg-enabled').checked = dirList.enabled === true;
        card.__passwordConfigured = dirList.passwordConfigured === true;
        card.querySelector('.cfbed-dg-password').value = '';
        card.querySelector('.cfbed-dg-password').placeholder = dirList.passwordConfigured ? '输入新密码以修改（留空保持不变）' : '设置目录密码';
        refreshStatus(card);
    }

    // 保存：GET 最新全量 → 仅改 directoryList → 整体回传（POST 为全量覆盖语义）
    function saveCard(card, extra) {
        var saveBtn = card.querySelector('.cfbed-dg-save');
        var enabled = card.querySelector('.cfbed-dg-enabled').checked;
        var password = card.querySelector('.cfbed-dg-password').value;
        var clearRequested = extra && extra.clearPassword === true;

        if (enabled && !card.__passwordConfigured && !password && !clearRequested) {
            toast('启用门控前请先设置密码', 'error');
            return;
        }
        if (clearRequested && !card.__passwordConfigured) {
            toast('当前未设置密码', 'info');
            return;
        }

        saveBtn.disabled = true;
        saveBtn.textContent = '保存中...';

        loadOthersConfig().then(function (latest) {
            latest.directoryList = { enabled: enabled };
            if (clearRequested) {
                latest.directoryList.clearPassword = true;
            } else if (password) {
                latest.directoryList.password = password;
            }
            return authedFetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(latest)
            });
        }).then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
        }).then(function (data) {
            fillCard(card, data);
            toast(clearRequested ? '目录密码已清除' : '目录密码设置已保存', 'success');
        }).catch(function (err) {
            toast('保存失败：' + err.message, 'error');
        }).finally(function () {
            saveBtn.disabled = false;
            saveBtn.textContent = '保存设置';
        });
    }

    // ==================== 注入 ====================

    // 在"其他设置"页面的"音乐播放器"卡片后插入设置卡片
    function injectCard() {
        // 已注入则跳过（SPA 切换后 DOM 重建、卡片被移除时才需重新注入）；
        // 此检查必须放在 TreeWalker 全文遍历之前，避免每次 DOM 变更都全量扫描
        var existing = document.getElementById(CARD_ID);
        if (existing && document.contains(existing)) return;

        // 逐个元素找包含锚点文本的节点，向上定位卡片容器
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        var node;
        var anchorEl = null;
        while ((node = walker.nextNode())) {
            if (node.textContent.indexOf(ANCHOR_TEXT) !== -1) {
                anchorEl = node.parentElement;
                break;
            }
        }
        if (!anchorEl) return;

        // 向上找卡片容器：与音乐播放器设置同级的块
        var cardContainer = anchorEl.closest('.el-card')
            || anchorEl.closest('[class*="card"]')
            || anchorEl.closest('[class*="setting"]')
            || anchorEl.parentElement;
        if (!cardContainer || !cardContainer.parentElement) return;

        var card = buildCard();
        cardContainer.parentElement.insertBefore(card, cardContainer.nextSibling);

        card.querySelector('.cfbed-dg-enabled').addEventListener('change', function () { refreshStatus(card); });
        card.querySelector('.cfbed-dg-save').addEventListener('click', function () { saveCard(card); });
        card.querySelector('.cfbed-dg-clear').addEventListener('click', function () {
            if (window.confirm('确定清除目录密码吗？清除后若门控仍启用，将无法通过密码查看目录列表。')) {
                saveCard(card, { clearPassword: true });
            }
        });

        // 回显当前配置
        loadOthersConfig().then(function (config) {
            if (document.contains(card)) fillCard(card, config);
        }).catch(function () { /* 静默：保存时仍会拉取 */ });
    }

    function injectStyles() {
        if (document.getElementById('cfbed-directory-guard-styles')) return;
        var style = document.createElement('style');
        style.id = 'cfbed-directory-guard-styles';
        style.textContent = [
            '.cfbed-dg-card {',
            '  margin: 16px 0; padding: 16px 20px;',
            '  border: 1px solid var(--el-border-color-lighter, #eee);',
            '  border-radius: 12px;',
            '  background: var(--el-bg-color, #fff);',
            '  font-family: inherit; color: var(--el-text-color-primary, inherit);',
            '}',
            '.cfbed-dg-title { font-size: 15px; font-weight: 600; margin-bottom: 6px; }',
            '.cfbed-dg-desc {',
            '  font-size: 12px; line-height: 1.6;',
            '  color: var(--el-text-color-secondary, #909399);',
            '  margin-bottom: 12px;',
            '}',
            '.cfbed-dg-row {',
            '  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;',
            '  margin-bottom: 10px;',
            '}',
            '.cfbed-dg-switch {',
            '  display: inline-flex; align-items: center; gap: 6px;',
            '  font-size: 13px; cursor: pointer;',
            '}',
            '.cfbed-dg-status {',
            '  font-size: 12px; color: var(--el-text-color-secondary, #909399);',
            '}',
            '.cfbed-dg-password {',
            '  flex: 1; min-width: 200px; max-width: 360px;',
            '  padding: 8px 12px; font-size: 13px; font-family: inherit;',
            '  border: 1px solid var(--el-border-color, #dcdfe6); border-radius: 6px;',
            '  background: var(--el-fill-color-blank, #fff);',
            '  color: var(--el-text-color-regular, #606266); outline: none;',
            '}',
            '.cfbed-dg-password:focus { border-color: var(--el-color-primary, #409eff); }',
            '.cfbed-dg-actions { display: flex; gap: 8px; }',
            '.cfbed-dg-btn {',
            '  padding: 7px 16px; font-size: 13px; font-family: inherit; cursor: pointer;',
            '  border-radius: 6px; border: 1px solid var(--el-border-color, #dcdfe6);',
            '  background: var(--el-bg-color, #fff);',
            '  color: var(--el-text-color-regular, #606266);',
            '}',
            '.cfbed-dg-btn:hover { opacity: .9; }',
            '.cfbed-dg-btn:disabled { opacity: .6; cursor: not-allowed; }',
            '.cfbed-dg-btn.is-primary {',
            '  background: var(--el-color-primary, #409eff); color: #fff; border-color: transparent;',
            '}',
        ].join('\n');
        document.head.appendChild(style);
    }

    function init() {
        injectStyles();
        var scheduled = false;
        var scheduleInject = function () {
            if (scheduled) return;
            scheduled = true;
            var run = function () { scheduled = false; injectCard(); };
            if (typeof global.requestAnimationFrame === 'function') {
                global.requestAnimationFrame(run);
            } else {
                setTimeout(run, 16);
            }
        };
        new global.MutationObserver(scheduleInject).observe(document.documentElement, {
            childList: true,
            subtree: true,
        });
        setTimeout(injectCard, 0);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})(typeof globalThis !== 'undefined' ? globalThis : window);
