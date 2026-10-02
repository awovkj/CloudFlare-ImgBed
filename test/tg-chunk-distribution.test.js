import assert from 'node:assert/strict';

import { selectTelegramChunkChannel } from '../functions/upload/chunkUpload.js';

function makeContext({ channels, loadBalance, specifiedChannelName }) {
  return {
    uploadConfig: {
      telegram: {
        channels,
        loadBalance: { enabled: loadBalance },
      },
    },
    specifiedChannelName,
  };
}

const BOTS = [
  { name: 'bot-a', botToken: 'token-a', chatId: '1' },
  { name: 'bot-b', botToken: 'token-b', chatId: '2' },
  { name: 'bot-c', botToken: 'token-c', chatId: '3' },
];

describe('Telegram chunk distribution across bots', () => {
  it('keeps all chunks on one bot when load balancing is disabled', () => {
    const context = makeContext({ channels: BOTS, loadBalance: false });
    const picked = [0, 1, 2, 3, 4, 5].map(i => selectTelegramChunkChannel(context, 'up1', i));

    assert.equal(
      new Set(picked.map(c => c.name)).size,
      1,
      '未启用负载均衡时不应分散',
    );
  });

  it('honours an explicitly specified channel and does not spread', () => {
    const context = makeContext({
      channels: BOTS,
      loadBalance: true,
      specifiedChannelName: 'bot-b',
    });

    const picked = [0, 1, 2, 3].map(i => selectTelegramChunkChannel(context, 'up1', i).name);
    assert.deepEqual(picked, ['bot-b', 'bot-b', 'bot-b', 'bot-b']);
  });

  it('round-robins chunks across the bot pool when load balancing is enabled', () => {
    const context = makeContext({ channels: BOTS, loadBalance: true });

    const picked = [0, 1, 2, 3, 4, 5].map(i => selectTelegramChunkChannel(context, 'up1', i).name);
    assert.deepEqual(picked, ['bot-a', 'bot-b', 'bot-c', 'bot-a', 'bot-b', 'bot-c']);
  });

  it('spreads a 64-chunk (1GB) file evenly across the pool', () => {
    const context = makeContext({ channels: BOTS, loadBalance: true });

    const counts = {};
    for (let i = 0; i < 64; i++) {
      const name = selectTelegramChunkChannel(context, 'up1', i).name;
      counts[name] = (counts[name] || 0) + 1;
    }

    // 64 / 3 → 22, 21, 21 —— 轮询分配下最大与最小相差不超过 1
    assert.deepEqual(Object.values(counts).sort((a, b) => b - a), [22, 21, 21]);
  });

  it('returns the only bot when a single channel is configured', () => {
    const context = makeContext({ channels: [BOTS[0]], loadBalance: true });

    const picked = [0, 1, 2].map(i => selectTelegramChunkChannel(context, 'up1', i).name);
    assert.deepEqual(picked, ['bot-a', 'bot-a', 'bot-a']);
  });

  it('returns null when no Telegram channel is configured', () => {
    const context = makeContext({ channels: [], loadBalance: true });
    assert.equal(selectTelegramChunkChannel(context, 'up1', 0), null);
  });

  it('tolerates a missing or invalid chunkIndex without throwing', () => {
    const context = makeContext({ channels: BOTS, loadBalance: true });

    assert.equal(selectTelegramChunkChannel(context, 'up1', undefined).name, 'bot-a');
    assert.equal(selectTelegramChunkChannel(context, 'up1', -1).name, 'bot-a');
    assert.equal(selectTelegramChunkChannel(context, 'up1', 'not-a-number').name, 'bot-a');
  });
});
