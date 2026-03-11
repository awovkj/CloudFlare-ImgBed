/**
 * 文件统计小部件 - 可嵌入到上传页面
 * 使用方法：在页面中添加 <div id="file-stats-widget"></div>
 * 然后引入此脚本即可
 */

(function() {
    'use strict';

    const style = document.createElement('style');
    style.textContent = `
        .file-stats-widget {
            background: linear-gradient(135deg, rgba(64, 158, 255, 0.92) 0%, rgba(161, 227, 204, 0.92) 100%);
            border-radius: 18px;
            padding: 20px;
            color: white;
            box-shadow: 0 6px 30px rgba(64, 158, 255, 0.35), 0 0 0 1px rgba(255, 255, 255, 0.15);
            backdrop-filter: blur(25px) saturate(180%);
            -webkit-backdrop-filter: blur(25px) saturate(180%);
            margin: 20px 0;
            animation: widgetFadeIn 0.7s cubic-bezier(0.34, 1.56, 0.64, 1);
            font-family: Avenir, Helvetica, Arial, sans-serif;
            transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
            position: relative;
            overflow: visible;
        }

        .file-stats-widget::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: linear-gradient(135deg, rgba(255, 255, 255, 0.1) 0%, transparent 50%);
            pointer-events: none;
            border-radius: 18px;
        }

        .file-stats-widget:hover {
            box-shadow: 0 12px 40px rgba(64, 158, 255, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.2);
            transform: translateY(-3px);
        }

        @keyframes widgetFadeIn {
            from {
                opacity: 0;
                transform: translateY(20px) scale(0.92);
            }
            to {
                opacity: 1;
                transform: translateY(0) scale(1);
            }
        }

        .file-stats-widget h3 {
            margin: 0 0 18px 0;
            font-size: 19px;
            font-weight: 700;
            display: flex;
            align-items: center;
            gap: 10px;
            text-shadow: 0 3px 10px rgba(0, 0, 0, 0.2);
            letter-spacing: 0.8px;
            position: relative;
            z-index: 1;
        }

        .file-stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(85px, 1fr));
            gap: 12px;
            margin-bottom: 18px;
            position: relative;
            z-index: 1;
        }

        .file-stats-item {
            background: rgba(255, 255, 255, 0.18);
            padding: 16px 12px;
            border-radius: 14px;
            text-align: center;
            backdrop-filter: blur(15px);
            -webkit-backdrop-filter: blur(15px);
            border: 1px solid rgba(255, 255, 255, 0.25);
            transition: all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
            cursor: default;
            position: relative;
            overflow: visible;
        }

        .file-stats-item:hover {
            background: rgba(255, 255, 255, 0.28);
            transform: translateY(-4px) scale(1.03);
            box-shadow: 0 8px 20px rgba(0, 0, 0, 0.25);
            border-color: rgba(255, 255, 255, 0.4);
        }

        .file-stats-value {
            font-size: 24px;
            font-weight: 800;
            margin-bottom: 5px;
            background: linear-gradient(135deg, #ffffff 0%, #e8f4ff 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            text-shadow: none;
            letter-spacing: -0.8px;
            position: relative;
            z-index: 1;
        }

        .file-stats-label {
            font-size: 11px;
            opacity: 0.95;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 1px;
            position: relative;
            z-index: 1;
        }

        .file-stats-chart {
            background: rgba(255, 255, 255, 0.12);
            border-radius: 14px;
            padding: 16px;
            margin-top: 16px;
            border: 1px solid rgba(255, 255, 255, 0.2);
            backdrop-filter: blur(15px);
            -webkit-backdrop-filter: blur(15px);
            position: relative;
            overflow: visible;
        }

        .file-stats-chart::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: radial-gradient(circle at 30% 30%, rgba(255, 255, 255, 0.08), transparent 70%);
            pointer-events: none;
        }

        .file-stats-chart-title {
            font-size: 13px;
            font-weight: 700;
            margin-bottom: 14px;
            text-align: center;
            letter-spacing: 0.5px;
            opacity: 0.95;
            text-shadow: 0 2px 4px rgba(0, 0, 0, 0.15);
            position: relative;
            z-index: 1;
        }

        .file-stats-horizontal-bar {
            display: flex;
            align-items: center;
            margin-bottom: 14px;
            gap: 10px;
            position: relative;
            z-index: 1;
            flex-wrap: nowrap;
        }

        .file-stats-horizontal-bar:last-child {
            margin-bottom: 0;
        }

        .file-stats-bar-label {
            min-width: 50px;
            font-size: 11px;
            text-transform: uppercase;
            font-weight: 700;
            letter-spacing: 0.6px;
            opacity: 0.95;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
            flex-shrink: 0;
        }

        .file-stats-bar-track {
            flex: 1;
            background: rgba(255, 255, 255, 0.15);
            border-radius: 10px;
            height: 24px;
            overflow: visible;
            position: relative;
            box-shadow: inset 0 3px 6px rgba(0, 0, 0, 0.12);
            backdrop-filter: blur(10px);
            -webkit-backdrop-filter: blur(10px);
            min-width: 0;
        }

        .file-stats-bar-fill {
            height: 100%;
            border-radius: 10px;
            transition: width 1s cubic-bezier(0.34, 1.56, 0.64, 1);
            display: flex;
            align-items: center;
            justify-content: flex-end;
            padding-right: 0;
            box-shadow: 0 3px 10px rgba(0, 0, 0, 0.25);
            animation: barSlideIn 1s cubic-bezier(0.34, 1.56, 0.64, 1);
            position: relative;
            overflow: visible;
            min-width: 0;
        }

        @keyframes barSlideIn {
            from {
                width: 0 !important;
                opacity: 0;
            }
            to {
                width: var(--target-width);
                opacity: 1;
            }
        }

        .file-stats-bar-value {
            font-size: 10px;
            font-weight: 800;
            color: white;
            text-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
            letter-spacing: 0.3px;
            position: relative;
            z-index: 1;
            white-space: nowrap;
            overflow: visible;
        }

        .file-stats-bar-size {
            font-size: 9px;
            font-weight: 600;
            color: rgba(255, 255, 255, 0.85);
            margin-left: 8px;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
            flex-shrink: 0;
            white-space: nowrap;
            min-width: 60px;
        }

        .file-stats-refresh {
            background: rgba(255, 255, 255, 0.22);
            border: 1px solid rgba(255, 255, 255, 0.3);
            color: white;
            padding: 11px 18px;
            border-radius: 12px;
            font-size: 13px;
            cursor: pointer;
            transition: all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
            font-weight: 700;
            display: block;
            width: 100%;
            margin-top: 16px;
            text-transform: uppercase;
            letter-spacing: 1px;
            box-shadow: 0 3px 12px rgba(0, 0, 0, 0.15);
            backdrop-filter: blur(10px);
            -webkit-backdrop-filter: blur(10px);
            position: relative;
        }

        .file-stats-refresh:hover {
            background: rgba(255, 255, 255, 0.32);
            transform: translateY(-3px);
            box-shadow: 0 6px 18px rgba(0, 0, 0, 0.25);
            border-color: rgba(255, 255, 255, 0.45);
        }

        .file-stats-refresh:active {
            transform: translateY(-1px);
        }

        .file-stats-loading {
            text-align: center;
            padding: 28px 18px;
            font-size: 14px;
            opacity: 0.95;
            font-weight: 600;
            position: relative;
            z-index: 1;
        }

        .file-stats-loading::after {
            content: '';
            display: inline-block;
            width: 18px;
            height: 18px;
            margin-left: 12px;
            border: 2px solid rgba(255, 255, 255, 0.3);
            border-top-color: white;
            border-radius: 50%;
            animation: loadingSpin 0.9s linear infinite;
            vertical-align: middle;
        }

        @keyframes loadingSpin {
            to {
                transform: rotate(360deg);
            }
        }

        .file-stats-error {
            background: rgba(255, 87, 87, 0.25);
            padding: 14px;
            border-radius: 12px;
            font-size: 12px;
            text-align: center;
            border: 1px solid rgba(255, 87, 87, 0.35);
            font-weight: 600;
            backdrop-filter: blur(10px);
            -webkit-backdrop-filter: blur(10px);
            box-shadow: 0 3px 10px rgba(255, 87, 87, 0.2);
        }

        .file-stats-link {
            display: block;
            text-align: center;
            color: white;
            text-decoration: none;
            font-size: 11px;
            margin-top: 14px;
            opacity: 0.88;
            transition: all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
            font-weight: 600;
            padding: 10px;
            border-radius: 10px;
            letter-spacing: 0.6px;
            position: relative;
            z-index: 1;
        }

        .file-stats-link:hover {
            opacity: 1;
            background: rgba(255, 255, 255, 0.12);
            text-decoration: none;
            transform: translateY(-2px);
        }

        .file-stats-pie-chart {
            position: relative;
            width: 100%;
            height: 130px;
            margin: 16px 0;
            display: flex;
            justify-content: center;
            align-items: center;
            z-index: 1;
        }

        .file-stats-pie-legend {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-top: 12px;
            justify-content: center;
            position: relative;
            z-index: 1;
        }

        .file-stats-pie-legend-item {
            display: flex;
            align-items: center;
            gap: 5px;
            font-size: 10px;
            background: rgba(255, 255, 255, 0.15);
            padding: 5px 10px;
            border-radius: 12px;
            font-weight: 700;
            transition: all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
            border: 1px solid rgba(255, 255, 255, 0.2);
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
        }

        .file-stats-pie-legend-item:hover {
            background: rgba(255, 255, 255, 0.25);
            transform: scale(1.08);
            border-color: rgba(255, 255, 255, 0.35);
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        }

        .file-stats-pie-legend-color {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
        }
    `;
    document.head.appendChild(style);

    class FileStatsWidget {
        constructor(containerId) {
            this.container = document.getElementById(containerId);
            this.currentAbortController = null;
            this.inflightPromise = null;
            this.cacheKey = 'file-stats-widget-cache-v1';
            this.cacheTTL = 60 * 1000;
            this.backgroundRefreshThreshold = 15 * 1000;
            this.statsDisabled = false;
            if (!this.container) {
                console.error('File stats widget container not found:', containerId);
                return;
            }
            
            this.init();
            this.setupRouteListener();
        }

        shouldShowWidget() {
            const currentPath = window.location.pathname;
            return currentPath === '/' || currentPath === '/index.html';
        }

        updateVisibility() {
            if (this.statsDisabled) {
                this.container.style.display = 'none';
                return;
            }
            if (this.shouldShowWidget()) {
                this.container.style.display = 'block';
                if (!this.container.innerHTML || this.container.innerHTML.includes('正在加载统计数据') || this.container.innerHTML.includes('加载失败')) {
                    this.container.innerHTML = `
                        <h3>📊 存储统计</h3>
                        <div class="file-stats-loading">正在加载统计数据...</div>
                    `;
                    this.loadStats();
                }
            } else {
                this.container.style.display = 'none';
            }
        }

        setupRouteListener() {
            const checkRoute = () => {
                this.updateVisibility();
            };

            window.addEventListener('popstate', checkRoute);

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
            this.container.className = 'file-stats-widget';
            this.setupRouteListener();
            this.checkConfigAndShow();
        }

        async checkConfigAndShow() {
            try {
                const resp = await fetch('/api/manage/sysConfig/showStats', { cache: 'no-store' });
                if (resp.ok) {
                    const data = await resp.json();
                    if (data.enabled === false) {
                        this.statsDisabled = true;
                        this.container.style.display = 'none';
                        try { localStorage.removeItem(this.cacheKey); } catch(e) {}
                        return;
                    }
                }
            } catch (e) {
                // network error: show widget by default
            }
            this.updateVisibility();
        }

        getCache() {
            try {
                const raw = localStorage.getItem(this.cacheKey);
                if (!raw) {
                    return null;
                }

                const parsed = JSON.parse(raw);
                if (!parsed || typeof parsed.timestamp !== 'number' || !parsed.data) {
                    return null;
                }

                return parsed;
            } catch (error) {
                return null;
            }
        }

        setCache(stats) {
            try {
                localStorage.setItem(this.cacheKey, JSON.stringify({
                    timestamp: Date.now(),
                    data: stats
                }));
            } catch (error) {
                return;
            }
        }

        normalizeStats(rawStats) {
            const stats = rawStats && typeof rawStats === 'object' ? rawStats : {};
            const totalFiles = Number(stats.totalFiles) || 0;
            const totalSize = Number(stats.totalSize) || 0;

            const fileTypesList = Array.isArray(stats.fileTypesList)
                ? stats.fileTypesList
                    .map((item) => ({
                        ext: String(item && item.ext ? item.ext : 'unknown'),
                        count: Number(item && item.count) || 0,
                        size: Number(item && item.size) || 0
                    }))
                    .filter((item) => item.count > 0 || item.size > 0)
                : [];

            return {
                totalFiles,
                totalSize,
                fileTypesList
            };
        }

        isFreshCache(cache) {
            if (!cache || typeof cache.timestamp !== 'number') {
                return false;
            }

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
                const response = await fetch('/api/manage/stats', {
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
                if (error.name === 'AbortError') {
                    return null;
                }

                throw error;
            } finally {
                if (this.currentAbortController === controller) {
                    this.currentAbortController = null;
                }

                if (this.inflightPromise === fetchPromise) {
                    this.inflightPromise = null;
                }
            }
        }

        async loadStats(forceRefresh = false) {
            if (this.statsDisabled) return;
            const cache = this.getCache();
            const cacheExists = !!cache && !!cache.data;
            const cacheIsFresh = cacheExists && this.isFreshCache(cache);

            if (!forceRefresh && cacheExists) {
                this.renderStats(cache.data);

                const cacheAge = Date.now() - cache.timestamp;
                if (cacheIsFresh && cacheAge < this.backgroundRefreshThreshold) {
                    return;
                }
            }

            try {
                const stats = await this.fetchStats({ forceRefresh });
                if (stats) {
                    this.renderStats(stats);
                }
            } catch (error) {
                console.error('Error loading stats:', error);

                if (cacheExists) {
                    this.renderStats(cache.data);
                    return;
                }

                this.container.innerHTML = `
                    <h3>📊 存储统计</h3>
                    <div class="file-stats-error">加载失败: ${this.escapeHtml(error.message)}</div>
                    <button class="file-stats-refresh" onclick="fileStatsWidget.loadStats(true)">重试</button>
                `;
            }
        }

        renderStats(rawStats) {
            if (this.statsDisabled) return;
            const stats = this.normalizeStats(rawStats);
            const topTypes = stats.fileTypesList.filter(t => t.size > 0).slice(0, 10);
            const maxSize = Math.max(...topTypes.map(t => t.size), 1);

            const colors = [
                '#409eff', '#67c23a', '#e6a23c', '#f56c6c', '#909399',
                '#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4', '#ffeaa7',
                '#dfe6e9', '#fd79a8', '#a29bfe', '#6c5ce7', '#00b894'
            ];

            this.container.innerHTML = `
                <h3>📊 存储统计</h3>
                
                <div class="file-stats-grid">
                    <div class="file-stats-item">
                        <div class="file-stats-value">${this.formatNumber(stats.totalFiles)}</div>
                        <div class="file-stats-label">文件总数</div>
                    </div>
                    <div class="file-stats-item">
                        <div class="file-stats-value">${this.formatSize(stats.totalSize)}</div>
                        <div class="file-stats-label">总大小</div>
                    </div>
                </div>

                <div class="file-stats-chart">
                    <div class="file-stats-chart-title">文件类型存储分布</div>
                    ${topTypes.map((type, index) => {
                        const logMax = Math.log10(maxSize + 1);
                        const logSize = Math.log10(type.size + 1);
                        let percentage = (logSize / logMax * 100).toFixed(1);
                        
                        if (parseFloat(percentage) < 10) {
                            percentage = Math.max(10, parseFloat(percentage)).toFixed(1);
                        }
                        
                        const barColor = colors[index % colors.length];
                        return `
                            <div class="file-stats-horizontal-bar">
                                <div class="file-stats-bar-label">${type.ext.toUpperCase()}</div>
                                <div class="file-stats-bar-track">
                                    <div class="file-stats-bar-fill" style="width: ${percentage}%; background: linear-gradient(90deg, ${barColor} 0%, ${barColor}dd 100%); --target-width: ${percentage}%;">
                                    </div>
                                </div>
                                <span class="file-stats-bar-size">${this.formatSize(type.size)}</span>
                            </div>
                        `;
                    }).join('')}
                </div>

                <button class="file-stats-refresh" onclick="fileStatsWidget.loadStats(true)">🔄 刷新数据</button>
                <a href="/stats.html" class="file-stats-link" target="_blank">查看完整统计 →</a>
            `;
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
            if (num >= 1000000) {
                return (num / 1000000).toFixed(1) + 'M';
            } else if (num >= 1000) {
                return (num / 1000).toFixed(1) + 'K';
            }
            return num.toLocaleString();
        }

        formatSize(size) {
            if (size >= 1024) {
                return (size / 1024).toFixed(2) + ' GB';
            } else if (size >= 1) {
                return size.toFixed(2) + ' MB';
            } else {
                return (size * 1024).toFixed(0) + ' KB';
            }
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
