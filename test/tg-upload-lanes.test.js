import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadScheduler() {
  const code = fs.readFileSync('js/tg-upload-lanes.js', 'utf8');
  const context = { console };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(code, context);
  return context.TgUploadLaneScheduler;
}

describe('TgUploadLaneScheduler', () => {
  let scheduler;

  beforeEach(() => {
    scheduler = loadScheduler();
  });

  it('uses all unique Telegram channel names when no channel is selected', () => {
    const channels = [{ name: 'tg-a' }, { name: 'tg-b' }, { name: 'tg-a' }, { name: '' }];
    assert.deepEqual(Array.from(scheduler.getLaneNames('', channels)), ['tg-a', 'tg-b']);
  });

  it('uses only the selected Telegram channel when one is selected', () => {
    const channels = [{ name: 'tg-a' }, { name: 'tg-b' }];
    assert.deepEqual(Array.from(scheduler.getLaneNames('tg-b', channels)), ['tg-b']);
  });

  it('acquires one file per lane and waits when all lanes are busy', () => {
    const active = {};
    const channels = [{ name: 'tg-a' }, { name: 'tg-b' }, { name: 'tg-c' }];
    assert.equal(scheduler.acquireAvailableLane(active, '', channels), 'tg-a');
    assert.equal(scheduler.acquireAvailableLane(active, '', channels), 'tg-b');
    assert.equal(scheduler.acquireAvailableLane(active, '', channels), 'tg-c');
    assert.equal(scheduler.acquireAvailableLane(active, '', channels), '');
  });

  it('releases a lane so another file can use the same channel', () => {
    const active = {};
    const channels = [{ name: 'tg-a' }, { name: 'tg-b' }];
    assert.equal(scheduler.acquireAvailableLane(active, '', channels), 'tg-a');
    assert.equal(scheduler.acquireAvailableLane(active, '', channels), 'tg-b');
    scheduler.releaseLane(active, 'tg-a');
    assert.equal(scheduler.acquireAvailableLane(active, '', channels), 'tg-a');
  });

  it('falls back to one unnamed default lane when channel list is unavailable', () => {
    const active = {};
    const lane = scheduler.acquireAvailableLane(active, '', []);
    assert.equal(lane, scheduler.DEFAULT_LANE);
    assert.equal(scheduler.channelNameForLane(lane), '');
    assert.equal(scheduler.acquireAvailableLane(active, '', []), '');
  });

  it('removes queued file wrappers by uid', () => {
    const queue = [
      { file: { uid: 1 } },
      { file: { uid: 2 } },
      { file: { uid: 3 } }
    ];
    assert.deepEqual(scheduler.removeQueuedFile(queue, 2).map(item => item.file.uid), [1, 3]);
  });
});
