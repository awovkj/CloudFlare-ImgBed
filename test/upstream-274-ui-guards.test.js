import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import vm from 'node:vm';

describe('upstream UI guards', () => {
  it('exports session max-age normalization helper', () => {
    const code = fs.readFileSync('js/upstream-274-ui-guards.js', 'utf8');
    const context = { window: {}, document: { addEventListener(){}, querySelectorAll(){ return []; }, documentElement: {} }, MutationObserver: class { observe() {} }, XMLHttpRequest: function(){}, console, setTimeout };
    context.window = context;
    context.XMLHttpRequest.prototype.open = function(){};
    context.XMLHttpRequest.prototype.send = function(){};
    vm.createContext(context);
    vm.runInContext(code, context);
    assert.equal(context.Upstream274UiGuards.normalizeSessionMaxAgeDays('3650'), 3650);
    assert.equal(context.Upstream274UiGuards.normalizeSessionMaxAgeDays(0), 14);
  });
  it('is loaded before app chunks and gzip matches', () => {
    const html = fs.readFileSync('index.html', 'utf8');
    assert.match(html, /js\/upstream-274-ui-guards\.js/);
    assert.ok(html.indexOf('js/upstream-274-ui-guards.js') < html.indexOf('js/chunk-vendors'));
    assert.equal(zlib.gunzipSync(fs.readFileSync('js/upstream-274-ui-guards.js.gz')).toString('utf8'), fs.readFileSync('js/upstream-274-ui-guards.js', 'utf8'));
  });
});
