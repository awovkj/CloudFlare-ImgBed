(function attachTgUploadLaneScheduler(global) {
  'use strict';

  const DEFAULT_LANE = '__tg_default__';

  // 全局最多同时上传两个 Telegram 文件；同一个 bot（车道）仍只运行一个文件。
  // 这样不会把并发叠加到同一个 bot 上触发 429，同时允许配置了多个 bot 时
  // 充分利用独立的网络连接。单个大文件内部的分片并发由上传组件单独控制。
  const MAX_CONCURRENT_UPLOADS = 2;
  const MAX_CONCURRENT_PER_LANE = 1;

  function normalizeName(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function getLaneNames(selectedChannelName, channels) {
    const selected = normalizeName(selectedChannelName);
    if (selected) return [selected];

    const names = [];
    const seen = new Set();
    if (Array.isArray(channels)) {
      for (const channel of channels) {
        const name = normalizeName(typeof channel === 'string' ? channel : channel && channel.name);
        if (!name || seen.has(name)) continue;
        seen.add(name);
        names.push(name);
      }
    }
    return names;
  }

  function acquireAvailableLane(activeChannels, selectedChannelName, channels) {
    const active = activeChannels || {};
    const activeUploadCount = Object.values(active).reduce((total, count) => {
      const normalizedCount = Number(count);
      return total + (Number.isFinite(normalizedCount) && normalizedCount > 0 ? normalizedCount : 0);
    }, 0);

    // 达到全局上限时等待；每个车道仍由下面的 per-lane 限制独立保护。
    if (activeUploadCount >= MAX_CONCURRENT_UPLOADS) return '';

    const laneNames = getLaneNames(selectedChannelName, channels);
    const candidates = laneNames.length ? laneNames : [DEFAULT_LANE];
    // 选择当前负载最低且未达到车道上限的车道。
    let bestLane = '';
    let lowestCount = MAX_CONCURRENT_PER_LANE;
    for (const laneName of candidates) {
      const count = active[laneName] || 0;
      if (count < lowestCount) {
        bestLane = laneName;
        lowestCount = count;
      }
    }
    if (bestLane) {
      active[bestLane] = (active[bestLane] || 0) + 1;
      return bestLane;
    }
    return '';
  }

  function releaseLane(activeChannels, laneName) {
    if (!activeChannels || !laneName) return;
    const remaining = (activeChannels[laneName] || 0) - 1;
    if (remaining > 0) {
      activeChannels[laneName] = remaining;
    } else {
      delete activeChannels[laneName];
    }
  }

  function channelNameForLane(laneName) {
    return laneName === DEFAULT_LANE ? '' : normalizeName(laneName);
  }

  function removeQueuedFile(queue, uid) {
    if (!Array.isArray(queue)) return [];
    return queue.filter(item => item && item.file && item.file.uid !== uid);
  }

  global.TgUploadLaneScheduler = {
    DEFAULT_LANE,
    MAX_CONCURRENT_UPLOADS,
    MAX_CONCURRENT_PER_LANE,
    normalizeName,
    getLaneNames,
    acquireAvailableLane,
    releaseLane,
    channelNameForLane,
    removeQueuedFile
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
