import assert from 'node:assert/strict';
import fs from 'node:fs';

describe('upload context integration', () => {
  it('passes context.env into single-file upload page config lookup', () => {
    const source = fs.readFileSync('functions/upload/index.js', 'utf8');

    assert.match(
      source,
      /async function processFileUpload\(context, formdata = null\) \{\s*const \{ request, url, env \} = context;/,
      'processFileUpload must destructure env from context before calling fetchPageConfig(env)'
    );
  });
});
