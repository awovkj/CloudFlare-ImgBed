/**
 * 路由覆盖校验
 *
 * 解决的问题：项目迁到 Workers 后，路由不再由文件系统约定推导，而是集中登记在
 * src/routes.js。于是出现一个新的失效模式 —— 在 functions/ 下写了 handler，
 * 却忘了在路由表登记。此时请求会静默落到静态资源，返回 index.html，
 * 前端拿到 HTML 去 JSON.parse，报一个与真实原因无关的语法错误。
 *
 * 本模块的做法：纯文本分析（不加载模块图），交叉比对
 *   A. functions/ 下所有「导出 onRequest* 的 handler 文件」
 *   B. src/routes.js 中 import 的模块 + src/generatedAuthRoutes.js 覆盖的模块
 * 若 A 中存在不在 B 里的文件，即判定为漏登记。
 *
 * 为什么用纯文本而不是 import：加载完整模块图需要 node_modules 与 Cloudflare
 * 运行时环境，既慢又脆。路由登记是结构化事实，文本分析足够且零依赖。
 *
 * 关于「为什么不做全量自动生成」：本项目存在无法由文件路径推导的路由
 * （/music、/music/、/music.html 指向同一 handler；/api/site/* 是 /api/manage/*
 * 的别名），以及需要函数式参数提取的动态路由。因此选择「全量校验」而非
 * 「全量生成」—— 保证登记表与文件系统不漂移，同时保留人工表达力。
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 不参与路由登记的文件（有正当理由）。
 * 新增豁免必须在此写明原因，避免豁免清单变成垃圾场。
 */
const EXEMPT_PATTERNS = [
    // 中间件：导出 onRequest 但由 _middleware.js 约定挂载，不是独立路由。
    /(^|\/)_middleware\.js$/,

    // /api/auth/* 由 deploy/worker/generate-routes.js 生成到
    // src/generatedAuthRoutes.js，不在 src/routes.js 中登记。
    /^api\/auth\//,
];

function toPosix(p) {
    return p.replace(/\\/g, '/');
}

function walkJsFiles(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walkJsFiles(full, out);
        } else if (entry.name.endsWith('.js')) {
            out.push(full);
        }
    }
    return out;
}

/**
 * 判断文件是否导出了 Pages Functions 风格的 onRequest / onRequestGet / onRequestPost ...
 * 与 generate-routes.js 的 hasRouteExport 保持同一判定口径。
 */
export function hasRouteExport(content) {
    return /export\s+(async\s+)?function\s+onRequest(?:[A-Z][A-Za-z]+)?\b/m.test(content)
        || /export\s+const\s+onRequest(?:[A-Z][A-Za-z]+)?\b/m.test(content);
}

/**
 * 收集 functions/ 下所有应当被路由登记的 handler 文件。
 * @returns {string[]} 相对 functionsDir 的 posix 路径，已排序
 */
export function collectHandlerFiles(functionsDir) {
    return walkJsFiles(functionsDir)
        .map((full) => toPosix(path.relative(functionsDir, full)))
        // utils/ 是纯工具库目录，不承载路由
        .filter((rel) => !rel.startsWith('utils/'))
        .filter((rel) => !EXEMPT_PATTERNS.some((re) => re.test(rel)))
        .filter((rel) => hasRouteExport(fs.readFileSync(path.join(functionsDir, rel), 'utf8')))
        .sort();
}

/**
 * 从 src/routes.js 出发，递归收集所有可达的 functions/ 模块。
 *
 * 为什么要递归：handler 不一定被 routes.js 直接 import。例如
 * /upload 的 handler 由 src/uploadDispatcher.js 引用（forwardToUploadDO
 * 决定走 DO 还是 Worker 本地），而 uploadDispatcher 才被 routes.js import。
 * 只看直接 import 会把这类间接注册误判为「未登记」。
 *
 * @returns {Set<string>} 相对 functionsDir 的 posix 路径
 */
export function collectRegisteredModules(routesFile) {
    const collected = new Set();
    const seen = new Set();

    const visit = (filePath) => {
        if (seen.has(filePath) || !fs.existsSync(filePath)) {
            return;
        }
        seen.add(filePath);

        const source = fs.readFileSync(filePath, 'utf8');

        // functions/ 下的模块：登记
        const fnRe = /from\s+['"](?:\.\.\/)+functions\/([^'"]+)['"]/g;
        let match;
        while ((match = fnRe.exec(source)) !== null) {
            collected.add(match[1]);
        }

        // src/ 内部的同级模块：递归
        const localRe = /from\s+['"](\.\/[^'"]+)['"]/g;
        while ((match = localRe.exec(source)) !== null) {
            visit(path.resolve(path.dirname(filePath), match[1]));
        }
    };

    visit(routesFile);
    return collected;
}

/**
 * 从 src/generatedAuthRoutes.js 提取由生成器覆盖的模块路径。
 * @returns {Set<string>}
 */
export function collectGeneratedModules(generatedFile) {
    const modules = new Set();
    if (!fs.existsSync(generatedFile)) {
        return modules;
    }

    const source = fs.readFileSync(generatedFile, 'utf8');
    const re = /from\s+['"]\.\.\/functions\/([^'"]+)['"]/g;
    let match;
    while ((match = re.exec(source)) !== null) {
        modules.add(match[1]);
    }

    return modules;
}

/**
 * 提取「import 了但没在路由表里使用」的模块。
 *
 * 这是 collectRegisteredModules 的补充：后者以「是否 import」判定登记，
 * 只能发现「完全忘了 import」；而「import 了却忘了登记到路由表」需要看
 * 绑定名是否真的出现在路由表区域内。两者互补才能覆盖完整的失效模式。
 *
 * @returns {string[]} 相对 functionsDir 的模块路径
 */
export function collectUnusedImports(routesFile) {
    const source = fs.readFileSync(routesFile, 'utf8');

    // import { a as b, c } from '../functions/x.js'  /  import * as ns from '...'
    const importRe = /import\s+(?:\{([^}]*)\}|\*\s+as\s+(\w+))\s+from\s+['"]\.\.\/functions\/([^'"]+)['"]/g;

    const imports = [];
    let match;
    while ((match = importRe.exec(source)) !== null) {
        const named = match[1];
        const namespace = match[2];
        const modulePath = match[3];

        const bindings = [];
        if (namespace) {
            bindings.push(namespace);
        }
        if (named) {
            for (const part of named.split(',')) {
                const trimmed = part.trim();
                if (!trimmed) continue;
                const asMatch = trimmed.match(/\bas\s+(\w+)$/);
                bindings.push(asMatch ? asMatch[1] : trimmed);
            }
        }

        imports.push({ module: modulePath, bindings });
    }

    // 使用区域 = 全文去掉 import 语句。
    // 注意不能只取 STATIC_ROUTES 之后的片段 —— 中间件链（uploadMiddleware /
    // fileMiddleware / davMiddleware 等）定义在路由表之前，那样会把已使用的
    // handler 误判为未使用。
    const region = source.replace(/import\s+(?:[\s\S]*?)\s+from\s+['"][^'"]+['"];?/g, '');

    const unused = [];
    for (const entry of imports) {
        const used = entry.bindings.some((name) => new RegExp(`\\b${name}\\b`).test(region));
        if (!used) {
            unused.push(entry.module);
        }
    }

    return unused;
}

/**
 * 校验路由覆盖。
 *
 * @returns {{ok: boolean, total: number, registered: number,
 *            unregistered: string[], unusedImports: string[]}}
 */
export function verifyRouteCoverage({
    functionsDir,
    routesFile,
    generatedFile,
} = {}) {
    const handlers = collectHandlerFiles(functionsDir);
    const registered = collectRegisteredModules(routesFile);
    const generated = collectGeneratedModules(generatedFile);

    const unregistered = handlers.filter(
        (rel) => !registered.has(rel) && !generated.has(rel)
    );
    const unusedImports = collectUnusedImports(routesFile);

    return {
        ok: unregistered.length === 0 && unusedImports.length === 0,
        total: handlers.length,
        registered: handlers.length - unregistered.length,
        unregistered,
        unusedImports,
    };
}

/**
 * 供 CLI / 测试使用：格式化校验结果。
 */
export function formatCoverageResult(result, { routesRelPath = 'src/routes.js' } = {}) {
    const { unregistered = [], unusedImports = [] } = result;

    if (result.ok) {
        return `✓ Route coverage: ${result.registered}/${result.total} handlers registered`;
    }

    const lines = ['✗ Route coverage check failed', ''];

    if (unregistered.length > 0) {
        lines.push(`  ${unregistered.length} handler(s) export onRequest but are not imported by any route:`);
        for (const rel of unregistered) {
            lines.push(`    functions/${rel}`);
        }
        lines.push('');
    }

    if (unusedImports.length > 0) {
        lines.push(`  ${unusedImports.length} module(s) are imported but never used in the route table:`);
        for (const rel of unusedImports) {
            lines.push(`    functions/${rel}`);
        }
        lines.push('');
    }

    lines.push(`  Fix: wire them into ${routesRelPath}, or add an exemption in`);
    lines.push('       deploy/worker/route-coverage.js (with a documented reason).');
    return lines.join('\n');
}
