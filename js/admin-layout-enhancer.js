/**
 * 后台页面标记脚本
 *
 * 作用：把当前后台路由写到 <html data-admin-page="...">，供 css/admin-layout.css
 * 作为作用域钩子使用。
 *
 * 为什么需要它：
 * - 后台页面样式在编译后的路由分包里（css/443.*.css 等），带 Vue scoped 属性
 *   （.x[data-v-xxxx]），而分包 CSS 是访问路由时动态插入 <head> 的，位置在静态
 *   <link> 之后，"同特异性靠顺序取胜"不成立。挂一个 html 上的属性钩子，覆盖层
 *   就能稳定拿到更高特异性，不必到处写 !important。
 * - 同时把改动严格限制在后台路由，首页/上传页/公开图库不受影响。
 *
 * SPA 用 history.pushState 切路由，不会触发 popstate，因此这里包装
 * pushState/replaceState 并监听 popstate/hashchange。
 */
(function attachAdminLayoutEnhancer(global) {
    'use strict';

    var ATTR = 'data-admin-page';

    // 路由路径 → 标记值（与 css/admin-layout.css 中的选择器一一对应）
    var ROUTE_MAP = {
        '/dashboard': 'dashboard',
        '/systemConfig': 'systemConfig',
        '/customerConfig': 'customerConfig',
        '/adminLogin': 'adminLogin',
    };

    function normalizePath(pathname) {
        if (!pathname) return '/';
        // 去掉结尾多余的斜杠，/dashboard/ 与 /dashboard 视为同一路由
        var path = pathname.replace(/\/+$/, '');
        return path === '' ? '/' : path;
    }

    // 路由大小写在手输 URL 时容易不一致（/systemconfig），这里按小写匹配一次
    var LOWER_ROUTE_MAP = {};
    Object.keys(ROUTE_MAP).forEach(function (key) {
        LOWER_ROUTE_MAP[key.toLowerCase()] = ROUTE_MAP[key];
    });

    function resolvePage() {
        var path = normalizePath(global.location && global.location.pathname);
        return LOWER_ROUTE_MAP[path.toLowerCase()] || null;
    }

    function sync() {
        var root = document.documentElement;
        if (!root) return;
        var page = resolvePage();
        if (page) {
            if (root.getAttribute(ATTR) !== page) root.setAttribute(ATTR, page);
        } else if (root.hasAttribute(ATTR)) {
            root.removeAttribute(ATTR);
        }
    }

    function wrapHistoryMethod(name) {
        var original = global.history && global.history[name];
        if (typeof original !== 'function') return;
        global.history[name] = function () {
            var result = original.apply(this, arguments);
            // 路由组件与其分包 CSS 是异步挂载的，标记本身只依赖 location，立即同步即可
            sync();
            return result;
        };
    }

    function init() {
        sync();
        wrapHistoryMethod('pushState');
        wrapHistoryMethod('replaceState');
        global.addEventListener('popstate', sync);
        global.addEventListener('hashchange', sync);
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', sync);
        }
    }

    init();

    global.AdminLayoutEnhancer = {
        sync: sync,
        resolvePage: resolvePage,
        routes: ROUTE_MAP,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
