import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadScheduler() {
  const source = fs.readFileSync('js/tg-upload-lanes.js', 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source, context);
  return context.TgUploadLaneScheduler;
}

describe('Telegram upload lane scheduler', () => {
  it('allows one active file per channel and two across independent channels', () => {
    const scheduler = loadScheduler();
    const activeChannels = {};
    const channels = [{ name: 'primary' }, { name: 'backup' }];

    const firstLane = scheduler.acquireAvailableLane(activeChannels, '', channels);
    const secondLane = scheduler.acquireAvailableLane(activeChannels, '', channels);
    const waitingLane = scheduler.acquireAvailableLane(activeChannels, '', channels);

    assert.equal(scheduler.MAX_CONCURRENT_UPLOADS, 2);
    assert.equal(scheduler.MAX_CONCURRENT_PER_LANE, 1);
    assert.equal(firstLane, 'primary');
    assert.equal(secondLane, 'backup');
    assert.equal(waitingLane, '');
    assert.deepEqual({ ...activeChannels }, { primary: 1, backup: 1 });
  });

  it('starts the next file only after the active file releases its lane', () => {
    const scheduler = loadScheduler();
    const activeChannels = {};
    const channels = [{ name: 'primary' }, { name: 'backup' }];

    const firstLane = scheduler.acquireAvailableLane(activeChannels, '', channels);
    scheduler.releaseLane(activeChannels, firstLane);
    const nextLane = scheduler.acquireAvailableLane(activeChannels, 'backup', channels);

    assert.equal(nextLane, 'backup');
    assert.deepEqual({ ...activeChannels }, { backup: 1 });
  });

  it('serializes uploads that use the default Telegram credentials', () => {
    const scheduler = loadScheduler();
    const activeChannels = {};

    const firstLane = scheduler.acquireAvailableLane(activeChannels, '', []);
    const waitingLane = scheduler.acquireAvailableLane(activeChannels, '', []);

    assert.equal(firstLane, scheduler.DEFAULT_LANE);
    assert.equal(waitingLane, '');

    scheduler.releaseLane(activeChannels, firstLane);
    assert.equal(
      scheduler.acquireAvailableLane(activeChannels, '', []),
      scheduler.DEFAULT_LANE
    );
  });

  it('does not stack two files on an explicitly selected bot', () => {
    const scheduler = loadScheduler();
    const activeChannels = {};
    const channels = [{ name: 'primary' }, { name: 'backup' }];

    assert.equal(scheduler.acquireAvailableLane(activeChannels, 'primary', channels), 'primary');
    assert.equal(scheduler.acquireAvailableLane(activeChannels, 'primary', channels), '');
    assert.deepEqual({ ...activeChannels }, { primary: 1 });
  });
});
