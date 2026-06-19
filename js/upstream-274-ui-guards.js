(function attachUpstream274UiGuards(global) {
  'use strict';
  var DEFAULT_SESSION_DAYS = 14;
  function normalizeSessionMaxAgeDays(value) {
    var days = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (!Number.isFinite(days)) return DEFAULT_SESSION_DAYS;
    days = Math.trunc(days);
    if (days < 1 || days > 3650) return DEFAULT_SESSION_DAYS;
    return days;
  }
  function normalizeSecurityPayload(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    var access = payload.access || {};
    if ('adminSessionMaxAge' in access) access.adminSessionMaxAge = normalizeSessionMaxAgeDays(access.adminSessionMaxAge);
    if ('userSessionMaxAge' in access) access.userSessionMaxAge = normalizeSessionMaxAgeDays(access.userSessionMaxAge);
    payload.access = access;
    return payload;
  }
  function markChannelNameInputs(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('input').forEach(function(input) {
      var text = (input.placeholder || '') + ' ' + (input.getAttribute('aria-label') || '');
      if (/\u6e20\u9053\u540d\u79f0|channel name/i.test(text)) {
        input.setAttribute('data-upstream-274-channel-name-immutable', 'true');
        input.title = input.title || '\u6e20\u9053\u540d\u79f0\u7528\u4e8e\u5173\u8054\u5386\u53f2\u6587\u4ef6\uff0c\u4fdd\u5b58\u540e\u4e0d\u5efa\u8bae\u4fee\u6539\u3002';
      }
    });
  }
  function patchXhr() {
    if (!global.XMLHttpRequest || global.XMLHttpRequest.__upstream274Patched) return;
    var proto = global.XMLHttpRequest.prototype;
    var open = proto.open;
    var send = proto.send;
    proto.open = function(method, url) { this.__u274Method = method; this.__u274Url = String(url || ''); return open.apply(this, arguments); };
    proto.send = function(body) {
      if (this.__u274Method === 'POST' && this.__u274Url.indexOf('/api/manage/sysConfig/security') !== -1 && typeof body === 'string') {
        try { body = JSON.stringify(normalizeSecurityPayload(JSON.parse(body))); } catch (error) { console.warn('[upstream-274-ui-guards]', error.message); }
      }
      return send.call(this, body);
    };
    global.XMLHttpRequest.__upstream274Patched = true;
  }
  patchXhr();
  if (global.document) {
    var apply = function() { markChannelNameInputs(global.document); };
    global.document.addEventListener && global.document.addEventListener('DOMContentLoaded', apply);
    setTimeout(apply, 0);
    if (global.MutationObserver && global.document.documentElement) new global.MutationObserver(apply).observe(global.document.documentElement, { childList: true, subtree: true });
  }
  global.Upstream274UiGuards = { normalizeSessionMaxAgeDays: normalizeSessionMaxAgeDays, normalizeSecurityPayload: normalizeSecurityPayload, markChannelNameInputs: markChannelNameInputs };
})(typeof globalThis !== 'undefined' ? globalThis : window);
