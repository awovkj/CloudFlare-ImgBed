(function attachDocxFrame(global) {
    'use strict';

    function tellHost(type, message) {
        global.parent.postMessage({ source: 'doc-preview-docx', type: type, message: message || '' }, '*');
    }

    function stripActiveContent(container) {
        container.querySelectorAll('script, iframe, object, embed, link, meta, base, form, input, button, foreignObject, animate, animateTransform, set').forEach(function (node) {
            node.remove();
        });
        container.querySelectorAll('*').forEach(function (node) {
            Array.from(node.attributes).forEach(function (attribute) {
                if (/^on/i.test(attribute.name) || /^(href|xlink:href|srcdoc|action|formaction|target)$/i.test(attribute.name)) {
                    node.removeAttribute(attribute.name);
                }
                if (attribute.name.toLowerCase() === 'src' && !/^(data:|blob:)/i.test(attribute.value)) {
                    node.removeAttribute(attribute.name);
                }
            });
        });
    }

    var rendered = false;
    document.addEventListener('click', function (event) {
        if (event.target.closest && event.target.closest('a, area')) event.preventDefault();
    });
    global.addEventListener('message', async function (event) {
        if (event.source !== global.parent || event.origin !== new URL(global.location.href).origin
            || event.data?.source !== 'doc-preview-host'
            || event.data.type !== 'render' || rendered) return;
        rendered = true;
        try {
            if (!global.docx || !global.DocumentArchiveGuards) throw new Error('Local renderer is unavailable');
            DocumentArchiveGuards.inspectZip(event.data.buffer);
            var content = document.createElement('div');
            var styles = document.createElement('div');
            await global.docx.renderAsync(event.data.buffer, content, styles, {
                ignoreFonts: true,
                useBase64URL: true,
                renderAltChunks: false,
                renderComments: false,
                renderChanges: false,
                experimental: false,
            });
            stripActiveContent(content);
            document.getElementById('document').appendChild(content);
            document.getElementById('styles').appendChild(styles);
            document.getElementById('status').remove();
            tellHost('rendered');
        } catch (error) {
            document.getElementById('status').textContent = 'Document could not be rendered. Download the original file instead.';
            tellHost('error', error.message);
        }
    });
    tellHost('ready');
})(typeof globalThis !== 'undefined' ? globalThis : window);
