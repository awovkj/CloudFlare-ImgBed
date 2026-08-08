(function attachTgUploadLaneScheduler(global) {
  'use strict';

  const DEFAULT_LANE = '__tg_default__';

  // 多文件上传严格串行：不论有多少个 Telegram 渠道，同一时刻只放行一个文件。
  // 这里限制的是文件级调度，单个大文件内部的分片上传仍按原有逻辑执行。
  const MAX_CONCURRENT_UPLOADS = 1;
  const MAX_CONCURRENT_PER_LANE = MAX_CONCURRENT_UPLOADS;

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

    // 其他渠道空闲时也不放行新文件，确保全局只有一个文件正在上传。
    if (activeUploadCount >= MAX_CONCURRENT_UPLOADS) return '';

    const laneNames = getLaneNames(selectedChannelName, channels);
    const candidates = laneNames.length ? laneNames : [DEFAULT_LANE];
    // 选择可用车道；全局串行检查已保证本次最多只会放行一个文件。
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
