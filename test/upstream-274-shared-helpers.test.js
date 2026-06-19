import assert from 'node:assert/strict';

describe('upstream shared helpers', () => {
  it('strips secrets and config-derived metadata', async () => {
    const { stripSensitiveMetadata, cleanPersistedMetadata } = await import('../functions/utils/metadata/metadataSecurity.js');
    const raw = {
      FileName: 'cat.png', ChannelName: 'dav-a', WebDAVFilePath: 'cat.png',
      S3AccessKeyId: 'ak', S3SecretAccessKey: 'sk', TgBotToken: 'bot', HfToken: 'hf',
      WebDAVUsername: 'u', WebDAVPassword: 'p', WebDAVHeaders: { Authorization: 'x' },
      WebDAVBaseUrl: 'https://u:p@example.com/dav/', WebDAVPublicUrl: 'https://cdn/cat.png',
      S3Location: 'https://old/cat.png', HfFileUrl: 'https://hf/cat.png'
    };
    const view = stripSensitiveMetadata(raw);
    assert.equal(view.WebDAVBaseUrl, 'https://example.com/dav/');
    assert.equal(view.WebDAVPassword, undefined);
    assert.equal(view.WebDAVPublicUrl, 'https://cdn/cat.png');
    const persisted = cleanPersistedMetadata(raw);
    assert.equal(persisted.ChannelName, 'dav-a');
    assert.equal(persisted.WebDAVFilePath, 'cat.png');
    assert.equal(persisted.WebDAVPublicUrl, undefined);
    assert.equal(persisted.S3Location, undefined);
  });

  it('normalizes WebDAV URL and headers', async () => {
    const { normalizeBaseUrl, buildWebDAVUrl, normalizeWebDAVHeaders } = await import('../functions/utils/storage/webdavAPI.js');
    assert.equal(normalizeBaseUrl('https://example.com/dav'), 'https://example.com/dav/');
    assert.equal(buildWebDAVUrl('https://example.com/dav/', '/a b.txt'), 'https://example.com/dav/a%20b.txt');
    assert.deepEqual(normalizeWebDAVHeaders('{"X-Test":"1","Empty":""}'), { 'X-Test': '1' });
  });

  it('matches renamed channels by legacy identity fields', async () => {
    const { findConfiguredChannel } = await import('../functions/utils/metadata/channelConfig.js');
    const cfg = { webdav: { channels: [{ name: 'renamed', baseUrl: 'https://u:p@example.com/dav/', username: 'u' }] } };
    assert.equal(findConfiguredChannel(cfg, 'webdav', { WebDAVBaseUrl: 'https://example.com/dav', WebDAVUsername: 'u' }).name, 'renamed');
  });

  it('normalizes session max age', async () => {
    const { normalizeSessionMaxAgeDays, sessionMaxAgeDaysToTtl } = await import('../functions/utils/auth/sessionConfig.js');
    assert.equal(normalizeSessionMaxAgeDays('3650'), 3650);
    assert.equal(normalizeSessionMaxAgeDays(0), 14);
    assert.equal(normalizeSessionMaxAgeDays(Date.now()), 14);
    assert.equal(sessionMaxAgeDaysToTtl(2), 172800);
  });
});
