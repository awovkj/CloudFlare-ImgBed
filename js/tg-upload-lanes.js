(function attachTgUploadLaneScheduler(global) {
  'use strict';

  const DEFAULT_LANE = '__tg_default__';

  // Telegram 文件级严格串行：无论配置了多少个 bot（车道），同一时刻
  // 只允许一个文件上传，避免多个大文件各自开启分片并发后造成拥塞。
  // 单个活动文件内部的分片并发仍由上传组件单独控制。
  const MAX_CONCURRENT_UPLOADS = 1;
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

    // 任意 Telegram 文件正在上传时，其余文件统一等待；即使目标 bot 不同，
    // 也不能绕过文件级全局串行限制。
    if (activeUploadCount >= MAX_CONCURRENT_UPLOADS) return '';

    const laneNames = getLaneNames(selectedChannelName, channels);
    const candidates = laneNames.length ? laneNames : [DEFAULT_LANE];
    // 没有活动文件时选择一个可用车道。
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
