/**
 * 文件统计小部件 - 侧边栏嵌入式数据面板
 * 使用方法：在页面中添加 <div id="file-stats-widget"></div>
 * 然后引入此脚本即可
 */

(() => {

    const style = document.createElement('style');
    style.textContent = `
        .file-stats-widget {
            background: var(--theme-surface, rgba(255, 255, 255, 0.74));
            border-radius: var(--theme-radius-lg, 24px);
            padding: 22px;
            color: var(--theme-text, #15314b);
            box-shadow: var(--theme-shadow, 0 18px 50px rgba(44, 88, 140, 0.12));
            backdrop-filter: blur(22px) saturate(150%);
            -webkit-backdrop-filter: blur(22px) saturate(150%);
            border: 1px solid var(--theme-border, rgba(123, 164, 220, 0.22));
            margin: 20px 0;
            animation: widgetFadeIn 0.5s ease;
            font-family: 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
            position: relative;
            overflow: hidden;
        }

        .file-stats-widget::before {
            content: '';
            position: absolute;
            inset: 0;
            pointer-events: none;
            background: linear-gradient(135deg, rgba(255, 255, 255, 0.08), transparent 60%);
            border-radius: var(--theme-radius-lg, 24px);
        }

        @keyframes widgetFadeIn {
            from { opacity: 0; transform: translateY(16px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .file-stats-widget h3 {
            margin: 0 0 16px 0;
            font-size: 17px;
            font-weight: 700;
            display: flex;
            align-items: center;
            gap: 8px;
            position: relative;
            z-index: 1;
            color: var(--theme-text, #15314b);
        }

        /* ---- 汇总卡片 ---- */
        .file-stats-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
            margin-bottom: 16px;
            position: relative;
            z-index: 1;
        }

        .file-stats-item {
            position: relative;
            overflow: hidden;
            background: var(--md-primary, #3b66d6);
            padding: 14px 10px;
            border-radius: var(--theme-radius-md, 16px);
            text-align: center;
            color: var(--md-on-primary, #fff);
            box-shadow: var(--md-elev-1, 0 1px 3px rgba(0,0,0,.08));
            border: none;
        }

        .file-stats-item::before { display: none; }

        .file-stats-item.alt {
            background: var(--md-secondary, #3a8a82);
            color: var(--md-on-secondary, #fff);
        }

        .file-stats-value {
            font-size: 24px;
            font-weight: 800;
            margin-bottom: 4px;
            letter-spacing: -0.5px;
            position: relative;
            z-index: 1;
        }

        .file-stats-label {
            font-size: 9px;
            opacity: 0.88;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 1px;
            position: relative;
            z-index: 1;
        }

        /* ---- 环形图面板 ---- */
        .file-stats-chart-section {
            background: var(--theme-surface-strong, rgba(255, 255, 255, 0.88));
            border-radius: var(--theme-radius-md, 18px);
            padding: 14px;
            margin-top: 12px;
            border: 1px solid var(--theme-border, rgba(123, 164, 220, 0.16));
            box-shadow: 0 8px 20px rgba(38, 86, 150, 0.05);
            position: relative;
            z-index: 1;
        }

        .file-stats-chart-title {
            font-size: 11px;
            font-weight: 700;
            margin-bottom: 10px;
            text-align: center;
            letter-spacing: 0.5px;
            color: var(--theme-text-muted, #5f7992);
        }

        /* 环形图 */
        .file-stats-donut-container {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 10px;
        }

        .file-stats-donut-wrap {
            position: relative;
            width: 110px;
            height: 110px;
            flex-shrink: 0;
        }

        .file-stats-donut-wrap svg {
            width: 100%;
            height: 100%;
            transform: rotate(-90deg);
        }

        .file-stats-donut-center {
            position: absolute;
            inset: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-direction: column;
        }

        .file-stats-donut-center-value {
            font-size: 16px;
            font-weight: 800;
            color: var(--theme-text, #15314b);
            letter-spacing: -0.5px;
        }

        .file-stats-donut-center-label {
            font-size: 8px;
            color: var(--theme-text-muted, #5f7992);
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .file-stats-donut-legend {
            display: flex;
            flex-wrap: wrap;
            gap: 4px 8px;
            justify-content: center;
        }

        .file-stats-legend-item {
            display: flex;
            align-items: center;
            gap: 4px;
            font-size: 10px;
            font-weight: 600;
            color: var(--theme-text, #15314b);
        }

        .file-stats-legend-dot {
            width: 7px;
            height: 7px;
            border-radius: 50%;
            flex-shrink: 0;
            box-shadow: 0 1px 4px rgba(0,0,0,0.15);
        }

        .file-stats-legend-value {
            color: var(--theme-text-muted, #5f7992);
            font-weight: 500;
            font-size: 9px;
            margin-left: 1px;
        }

        /* ---- 水平条形图 ---- */
        .file-stats-bar-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
            max-height: 200px;
            overflow-y: auto;
            padding-right: 4px;
        }

        .file-stats-bar-list::-webkit-scrollbar {
            width: 4px;
        }

        .file-stats-bar-list::-webkit-scrollbar-thumb {
            background: var(--md-outline-variant, rgba(0,0,0,.18));
            border-radius: 999px;
        }

        .file-stats-bar-list::-webkit-scrollbar-track {
            background: transparent;
            border-radius: 999px;
        }

        .file-stats-bar-row {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .file-stats-bar-label {
            min-width: 40px;
            font-size: 10px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.4px;
            color: var(--theme-text, #15314b);
            flex-shrink: 0;
            text-align: right;
        }

        .file-stats-bar-track {
            flex: 1;
            background: rgba(52, 143, 255, 0.08);
            border-radius: 999px;
            height: 18px;
            overflow: hidden;
            position: relative;
            min-width: 0;
        }

        .file-stats-bar-fill {
            height: 100%;
            border-radius: 999px;
            transition: width 0.8s cubic-bezier(0.34, 1.56, 0.64, 1);
            box-shadow: 0 3px 10px rgba(0, 0, 0, 0.12);
            min-width: 0;
        }

        .file-stats-bar-size {
            font-size: 9px;
            font-weight: 600;
            color: var(--theme-text-muted, #5f7992);
            flex-shrink: 0;
            white-space: nowrap;
            min-width: 50px;
            text-align: right;
        }

        /* ---- 底部操作 ---- */
        .file-stats-footer {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-top: 14px;
            position: relative;
            z-index: 1;
        }

        .file-stats-refresh-btn {
            background: var(--md-primary, #3b66d6);
            color: var(--md-on-primary, #fff);
            border: none;
            padding: 8px 18px;
            border-radius: 999px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            transition: box-shadow 0.2s;
            box-shadow: var(--md-elev-1, 0 1px 3px rgba(0,0,0,.08));
            letter-spacing: 0.3px;
        }

        .file-stats-refresh-btn:hover {
            box-shadow: var(--md-elev-2, 0 2px 6px rgba(0,0,0,.1));
        }

        .file-stats-refresh-btn:active {
            box-shadow: var(--md-elev-1, 0 1px 3px rgba(0,0,0,.08));
        }

        .file-stats-more-link {
            color: var(--theme-primary, #348fff);
            text-decoration: none;
            font-size: 11px;
            font-weight: 600;
            transition: opacity 0.2s;
            letter-spacing: 0.3px;
        }

        .file-stats-more-link:hover {
            opacity: 0.7;
        }

        /* ---- Loading / Error ---- */
        .file-stats-loading {
            text-align: center;
            padding: 24px 14px;
            font-size: 13px;
            font-weight: 600;
            color: var(--theme-text-muted, #5f7992);
            position: relative;
            z-index: 1;
        }

        .file-stats-loading::after {
            content: '';
            display: inline-block;
            width: 14px;
            height: 14px;
            margin-left: 8px;
            border: 2px solid rgba(52, 143, 255, 0.2);
            border-top-color: var(--theme-primary, #348fff);
            border-radius: 50%;
            animation: loadingSpin 0.8s linear infinite;
            vertical-align: middle;
        }

        @keyframes loadingSpin {
            to { transform: rotate(360deg); }
        }

        .file-stats-error {
            background: rgba(255, 87, 87, 0.1);
            padding: 12px;
            border-radius: var(--theme-radius-sm, 14px);
            font-size: 12px;
            text-align: center;
            border: 1px solid rgba(255, 87, 87, 0.18);
            font-weight: 600;
            color: #d13448;
        }
    `;
    document.head.appendChild(style);

    const COLORS = [
        '#348fff', '#37c6b6', '#e6a23c', '#f56c6c', '#909399',
        '#67c23a', '#a29bfe', '#fd79a8', '#45b7d1', '#ffeaa7',
        '#6c5ce7', '#00b894', '#ff6b6b', '#4ecdc4', '#96ceb4'
    ];
    const STORAGE_PANEL_CONFIG_URL = '/api/site/storage-panel';
    const STORAGE_OVERVIEW_URL = '/api/site/storage-overview';

    class FileStatsWidget {
        constructor(containerId) {
            this.container = document.getElementById(containerId);
            this.containerWrapper = this.container ? this.container.parentElement : null;
            this.currentAbortController = null;
            this.inflightPromise = null;
            this.cacheKey = 'file-stats-widget-cache-v2';
            this.cacheTTL = 60 * 1000;
            this.backgroundRefreshThreshold = 15 * 1000;
            this.statsDisabled = false;
            this.initialized = false;
            if (!this.container) {
                return;
            }

            this.init();
            this.setupRouteListener();
        }

        setPendingState() {
            if (this.containerWrapper) {
                this.containerWrapper.classList.add('is-pending');
                this.containerWrapper.classList.remove('is-ready');
            }
            if (this.container) {
                this.container.style.display = 'none';
            }
        }

        setReadyState() {
            if (this.containerWrapper) {
                this.containerWrapper.classList.remove('is-pending');
                this.containerWrapper.classList.add('is-ready');
            }
        }

        renderLoadingSkeleton() {
            if (!this.container) return;
            this.container.className = 'file-stats-widget';
            this.container.innerHTML = `
                <h3>📊 存储统计</h3>
                <div class="file-stats-loading">正在加载统计数据...</div>
            `;
        }

        shouldShowWidget() {
            const currentPath = window.location.pathname;
            const hash = window.location.hash;
            const isHomePage = currentPath === '/' || currentPath === '/index.html' || currentPath.endsWith('/index.html');
            const isHashHome = hash === '' || hash === '#' || hash === '#/';
            return isHomePage && isHashHome;
        }

        updateVisibility() {
            if (this.statsDisabled || !this.container) {
                this.cleanup();
                return;
            }
            if (this.shouldShowWidget()) {
                this.container.style.display = 'block';
                this.setReadyState();
                const html = this.container.innerHTML || '';
                if (!html || html.includes('正在加载统计数据') || html.includes('加载失败')) {
                    this.renderLoadingSkeleton();
                    this.loadStats();
                }
            } else {
                this.container.style.display = 'none';
            }
        }

        setupRouteListener() {
            if (this.statsDisabled) return;
            
            const checkRoute = () => {
                if (!this.statsDisabled) {
                    this.updateVisibility();
                }
            };

            window.addEventListener('popstate', checkRoute);
            window.addEventListener('hashchange', checkRoute);

            if (!window.__fileStatsHistoryPatched) {
                const originalPushState = history.pushState;
                history.pushState = function(...args) {
                    originalPushState.apply(this, args);
                    setTimeout(checkRoute, 0);
                };

                const originalReplaceState = history.replaceState;
                history.replaceState = function(...args) {
                    originalReplaceState.apply(this, args);
                    setTimeout(checkRoute, 0);
                };

                window.__fileStatsHistoryPatched = true;
            }
        }

        init() {
            this.setPendingState();
            this.checkConfigAndShow();
        }

        async checkConfigAndShow() {
            try {
                const resp = await fetch(STORAGE_PANEL_CONFIG_URL, { cache: 'no-store' });
                if (resp.ok) {
                    const data = await resp.json();
                    if (data.enabled === false) {
                        this.statsDisabled = true;
                        this.cleanup();
                        try {
                            localStorage.removeItem(this.cacheKey);
                        } catch (_e) {}
                        return;
                    }
                }
                this.updateVisibility();
            } catch (_e) {
                this.updateVisibility();
            }
        }

        cleanup() {
            if (this.container) {
                this.container.innerHTML = '';
                this.container.style.display = 'none';
            }
            if (this.containerWrapper) {
                this.containerWrapper.innerHTML = '';
                this.containerWrapper.style.display = 'none';
                this.containerWrapper.remove();
            }
            this.container = null;
            this.containerWrapper = null;
        }

        getCache() {
            try {
                const raw = localStorage.getItem(this.cacheKey);
                if (!raw) return null;
                const parsed = JSON.parse(raw);
                if (!parsed || typeof parsed.timestamp !== 'number' || !parsed.data) return null;
                return parsed;
            } catch (_error) {
                return null;
            }
        }

        setCache(stats) {
            try {
                localStorage.setItem(this.cacheKey, JSON.stringify({
                    timestamp: Date.now(),
                    data: stats
                }));
            } catch (_error) {}
        }

        normalizeStats(rawStats) {
            const stats = rawStats && typeof rawStats === 'object' ? rawStats : {};
            const totalFiles = Number(stats.totalFiles) || 0;
            const totalSize = Number(stats.totalSize) || 0;

            const fileTypesList = Array.isArray(stats.fileTypesList)
                ? stats.fileTypesList
                    .map((item) => ({
                        ext: String(item?.ext ? item.ext : 'unknown'),
                        count: Number(item?.count) || 0,
                        size: Number(item?.size) || 0
                    }))
                    .filter((item) => item.count > 0 || item.size > 0)
                : [];

            const channelsList = Array.isArray(stats.channelsList)
                ? stats.channelsList
                    .map((item) => ({
                        channel: String(item?.channel || 'unknown'),
                        count: Number(item?.count) || 0,
                        size: Number(item?.size) || 0
                    }))
                    .filter((item) => item.count > 0 || item.size > 0)
                : [];

            return { totalFiles, totalSize, fileTypesList, channelsList };
        }

        isFreshCache(cache) {
            if (!cache || typeof cache.timestamp !== 'number') return false;
            return Date.now() - cache.timestamp <= this.cacheTTL;
        }

        async fetchStats({ forceRefresh = false } = {}) {
            if (!forceRefresh && this.inflightPromise) {
                return this.inflightPromise;
            }

            if (forceRefresh && this.currentAbortController) {
                this.currentAbortController.abort();
            }

            const controller = new AbortController();
            this.currentAbortController = controller;

            const fetchPromise = (async () => {
                const response = await fetch(STORAGE_OVERVIEW_URL, {
                    signal: controller.signal,
                    cache: 'no-store'
                });

                if (!response.ok) {
                    throw new Error(`获取数据失败(${response.status})`);
                }

                const stats = await response.json();
                const normalized = this.normalizeStats(stats);
                this.setCache(normalized);
                return normalized;
            })();

            this.inflightPromise = fetchPromise;

            try {
                return await fetchPromise;
            } catch (error) {
                if (error.name === 'AbortError') return null;
                throw error;
            } finally {
                if (this.currentAbortController === controller) this.currentAbortController = null;
                if (this.inflightPromise === fetchPromise) this.inflightPromise = null;
            }
        }

        async loadStats(forceRefresh = false) {
            if (this.statsDisabled || !this.container) return;
            const cache = this.getCache();
            const cacheExists = !!cache && !!cache.data;
            const cacheIsFresh = cacheExists && this.isFreshCache(cache);

            if (!forceRefresh && cacheExists) {
                if (this.container) {
                    this.container.style.display = 'block';
                }
                this.setReadyState();
                this.renderStats(cache.data);

                const cacheAge = Date.now() - cache.timestamp;
                if (cacheIsFresh && cacheAge < this.backgroundRefreshThreshold) return;
            }

            try {
                const stats = await this.fetchStats({ forceRefresh });
                if (stats && this.container) {
                    this.container.style.display = 'block';
                    this.setReadyState();
                    this.renderStats(stats);
                }
            } catch (error) {
                console.error('Error loading stats:', error);

                if (cacheExists && this.container) {
                    this.container.style.display = 'block';
                    this.setReadyState();
                    this.renderStats(cache.data);
                    return;
                }

                if (this.container) {
                    this.container.style.display = 'block';
                    this.setReadyState();
                    this.container.innerHTML = `
                        <h3>📊 存储统计</h3>
                        <div class="file-stats-error">加载失败: ${this.escapeHtml(error.message)}</div>
                        <div class="file-stats-footer">
                            <button class="file-stats-refresh-btn" onclick="fileStatsWidget.loadStats(true)">重试</button>
                        </div>
                    `;
                }
            }
        }

        /* ---- SVG 环形图 ---- */
        buildDonutSVG(items, centerValue, centerLabel) {
            const total = items.reduce((s, i) => s + i.value, 0);
            if (total === 0) return '<div style="text-align:center;padding:12px;opacity:0.5;font-size:12px">暂无数据</div>';

            const radius = 42;
            const circumference = 2 * Math.PI * radius;
            let offset = 0;

            const slices = items.map((item, idx) => {
                const pct = item.value / total;
                const dash = pct * circumference;
                const gap = circumference - dash;
                const slice = `<circle cx="55" cy="55" r="${radius}" fill="none" stroke="${COLORS[idx % COLORS.length]}" stroke-width="12" stroke-dasharray="${dash} ${gap}" stroke-dashoffset="${-offset}" stroke-linecap="round"/>`;
                offset += dash;
                return slice;
            });

            const legend = items.map((item, idx) => `
                <span class="file-stats-legend-item">
                    <span class="file-stats-legend-dot" style="background:${COLORS[idx % COLORS.length]}"></span>
                    ${this.escapeHtml(item.label)}
                    <span class="file-stats-legend-value">${item.display}</span>
                </span>
            `).join('');

            return `
                <div class="file-stats-donut-container">
                    <div class="file-stats-donut-wrap">
                        <svg viewBox="0 0 110 110">${slices.join('')}</svg>
                        <div class="file-stats-donut-center">
                            <div class="file-stats-donut-center-value">${centerValue}</div>
                            <div class="file-stats-donut-center-label">${centerLabel}</div>
                        </div>
                    </div>
                    <div class="file-stats-donut-legend">${legend}</div>
                </div>
            `;
        }

        renderStats(rawStats) {
            if (this.statsDisabled || !this.container) return;
            const stats = this.normalizeStats(rawStats);

            /* 文件类型存储分布（条形图）- 显示更多类型，支持滚动，按大小降序排列 */
            const topTypes = stats.fileTypesList
                .filter(t => t.size > 0)
                .sort((a, b) => b.size - a.size)
                .slice(0, 20);
            const maxSize = Math.max(...topTypes.map(t => t.size), 1);

            const barsHTML = topTypes.map((type, index) => {
                const logMax = Math.log10(maxSize + 1);
                const logSize = Math.log10(type.size + 1);
                let pct = (logSize / logMax * 100).toFixed(1);
                if (parseFloat(pct) < 10) pct = Math.max(10, parseFloat(pct)).toFixed(1);
                const color = COLORS[index % COLORS.length];
                return `
                    <div class="file-stats-bar-row">
                        <div class="file-stats-bar-label">${type.ext.toUpperCase()}</div>
                        <div class="file-stats-bar-track">
                            <div class="file-stats-bar-fill" style="width:${pct}%; background:linear-gradient(90deg,${color},${color}cc);"></div>
                        </div>
                        <span class="file-stats-bar-size">${this.formatSize(type.size)}</span>
                    </div>
                `;
            }).join('');

            /* 文件类型数量环形图 */
            const topTypesCount = stats.fileTypesList.filter(t => t.count > 0).slice(0, 6);
            const typeDonut = this.buildDonutSVG(
                topTypesCount.map(t => ({ label: t.ext.toUpperCase(), value: t.count, display: String(t.count) })),
                this.formatNumber(stats.totalFiles),
                '文件总数'
            );

            /* 存储渠道大小环形图 */
            const channelDonut = stats.channelsList.length > 0
                ? this.buildDonutSVG(
                    stats.channelsList.map(c => ({ label: c.channel, value: c.size, display: this.formatSize(c.size) })),
                    this.formatSize(stats.totalSize),
                    '总大小'
                )
                : '';

            this.container.innerHTML = `
                <h3>📊 存储统计</h3>

                <div class="file-stats-grid">
                    <div class="file-stats-item">
                        <div class="file-stats-value">${this.formatNumber(stats.totalFiles)}</div>
                        <div class="file-stats-label">文件总数</div>
                    </div>
                    <div class="file-stats-item alt">
                        <div class="file-stats-value">${this.formatSize(stats.totalSize)}</div>
                        <div class="file-stats-label">总大小</div>
                    </div>
                </div>

                <div class="file-stats-chart-section">
                    <div class="file-stats-chart-title">文件类型分布</div>
                    ${typeDonut}
                </div>

                ${channelDonut ? `
                <div class="file-stats-chart-section">
                    <div class="file-stats-chart-title">存储渠道分布</div>
                    ${channelDonut}
                </div>
                ` : ''}

                <div class="file-stats-chart-section">
                    <div class="file-stats-chart-title">类型存储占比</div>
                    <div class="file-stats-bar-list">${barsHTML || '<div style="text-align:center;padding:8px;opacity:0.5;font-size:12px">暂无数据</div>'}</div>
                </div>

                <div class="file-stats-footer">
                    <button class="file-stats-refresh-btn" onclick="fileStatsWidget.loadStats(true)">🔄 刷新</button>
                    <a href="/stats.html" class="file-stats-more-link" target="_blank">完整统计 →</a>
                </div>
            `;
            this.setReadyState();
        }

        escapeHtml(text) {
            return String(text || '')
                .replaceAll('&', '&amp;')
                .replaceAll('<', '&lt;')
                .replaceAll('>', '&gt;')
                .replaceAll('"', '&quot;')
                .replaceAll("'", '&#39;');
        }

        formatNumber(num) {
            if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
            if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
            return num.toLocaleString();
        }

        formatSize(size) {
            if (size >= 1024) return `${(size / 1024).toFixed(2)} GB`;
            if (size >= 1) return `${size.toFixed(2)} MB`;
            return `${(size * 1024).toFixed(0)} KB`;
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            window.fileStatsWidget = new FileStatsWidget('file-stats-widget');
        });
    } else {
        window.fileStatsWidget = new FileStatsWidget('file-stats-widget');
    }

})();
