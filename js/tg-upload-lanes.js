(function attachTgUploadLaneScheduler(global) {
  'use strict';

  const DEFAULT_LANE = '__tg_default__';

  // 每个渠道（车道）允许的并发上传数：>1 即开启多线程上传，不再局限于单线程。
  // 取值需兼顾 Telegram 限流（同一会话并发过高会触发 429，由后端重试退避兜底）。
  const MAX_CONCURRENT_PER_LANE = 3;

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
    const laneNames = getLaneNames(selectedChannelName, channels);
    const candidates = laneNames.length ? laneNames : [DEFAULT_LANE];
    // 选择当前并发最低的车道：多渠道间负载均衡，同时每个渠道最多并发 MAX_CONCURRENT_PER_LANE 个上传。
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
    normalizeName,
    getLaneNames,
    acquireAvailableLane,
    releaseLane,
    channelNameForLane,
    removeQueuedFile
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
