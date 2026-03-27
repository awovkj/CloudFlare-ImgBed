(function() {
  'use strict';

  var STORAGE_KEY = 'upload_resume_state';
  var isPaused = false;
  var controlPanel = null;
  var pauseBtn = null;
  var resumeBtn = null;
  var statusText = null;
  var uploadCount = 0;
  var pausedUploads = {};
  var chunkProgress = { uploaded: 0, total: 0 };

  function init() {
    createControlPanel();
    interceptUploads();
    loadState();
  }

  function createControlPanel() {
    controlPanel = document.createElement('div');
    controlPanel.id = 'upload-pause-control';
    controlPanel.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;display:none;flex-direction:column;gap:8px;';

    statusText = document.createElement('div');
    statusText.style.cssText = 'background:rgba(0,0,0,0.8);color:white;padding:12px 20px;border-radius:12px;font-size:13px;text-align:center;backdrop-filter:blur(12px);min-width:200px;';

    pauseBtn = document.createElement('button');
    pauseBtn.innerHTML = '⏸️ 暂停上传';
    pauseBtn.style.cssText = 'padding:12px 24px;border:none;border-radius:12px;font-size:14px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;background:linear-gradient(135deg,#ff9500,#ff5e3a);color:white;box-shadow:0 4px 16px rgba(255,94,58,0.4);transition:transform 0.2s;';
    pauseBtn.onmouseenter = function() { this.style.transform = 'scale(1.05)'; };
    pauseBtn.onmouseleave = function() { this.style.transform = 'scale(1)'; };
    pauseBtn.onclick = pauseUploads;

    resumeBtn = document.createElement('button');
    resumeBtn.innerHTML = '▶️ 继续上传';
    resumeBtn.style.cssText = 'padding:12px 24px;border:none;border-radius:12px;font-size:14px;font-weight:600;cursor:pointer;display:none;align-items:center;justify-content:center;gap:8px;background:linear-gradient(135deg,#34c759,#30d158);color:white;box-shadow:0 4px 16px rgba(52,199,89,0.4);transition:transform 0.2s;';
    resumeBtn.onmouseenter = function() { this.style.transform = 'scale(1.05)'; };
    resumeBtn.onmouseleave = function() { this.style.transform = 'scale(1)'; };
    resumeBtn.onclick = resumeUploads;

    controlPanel.appendChild(statusText);
    controlPanel.appendChild(pauseBtn);
    controlPanel.appendChild(resumeBtn);
    document.body.appendChild(controlPanel);
  }

  function showPanel() {
    if (controlPanel) controlPanel.style.display = 'flex';
  }

  function hidePanel() {
    if (controlPanel) controlPanel.style.display = 'none';
  }

  function setStatus(text) {
    if (statusText) statusText.innerHTML = text;
  }

  function saveState(uploadId, fileName, uploadedChunks, totalChunks) {
    try {
      var state = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      state[uploadId] = {
        uploadId: uploadId,
        fileName: fileName,
        uploadedChunks: uploadedChunks,
        totalChunks: totalChunks,
        timestamp: Date.now()
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.error('[UploadResume] Failed to save state:', e);
    }
  }

  function getSavedState(uploadId) {
    try {
      var state = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return state[uploadId] || null;
    } catch (e) {
      return null;
    }
  }

  function clearState(uploadId) {
    try {
      var state = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      delete state[uploadId];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {}
  }

  function loadState() {
    try {
      var state = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      var keys = Object.keys(state);
      if (keys.length > 0) {
        var latestKey = keys[keys.length - 1];
        var latest = state[latestKey];
        if (latest && latest.uploadId) {
          showPanel();
          pauseBtn.style.display = 'none';
          resumeBtn.style.display = 'flex';
          setStatus('发现未完成上传: ' + truncate(latest.fileName, 20) + '<br><small>点击继续恢复上传</small>');
          pausedUploads[latest.uploadId] = latest;
        }
      }
    } catch (e) {}
  }

  function truncate(str, len) {
    if (!str || str.length <= len) return str;
    return str.substring(0, len - 3) + '...';
  }

  function extractChunkInfo(args, isFormData) {
    var chunkIndex = null;
    var totalChunks = null;

    try {
      if (isFormData && args[1] && args[1].body) {
        var formData = args[1].body;
        if (formData instanceof FormData) {
          chunkIndex = formData.get('chunkIndex');
          totalChunks = formData.get('totalChunks');
        }
      }
    } catch (e) {}

    return {
      chunkIndex: chunkIndex !== null ? parseInt(chunkIndex) : null,
      totalChunks: totalChunks !== null ? parseInt(totalChunks) : null
    };
  }

  function updateChunkProgress(chunkIndex, totalChunks) {
    if (chunkIndex !== null && totalChunks !== null) {
      if (chunkProgress.total === 0 || chunkProgress.total !== totalChunks) {
        chunkProgress.total = totalChunks;
        chunkProgress.uploaded = 0;
      }
      chunkProgress.uploaded = Math.max(chunkProgress.uploaded, chunkIndex + 1);
    }
  }

  function getChunkStatusText() {
    if (chunkProgress.total > 0) {
      return '上传中... ' + chunkProgress.uploaded + '/' + chunkProgress.total + ' 分块';
    }
    return '上传中... (' + uploadCount + ' 个文件)';
  }

  function isCleanupUrl(url) {
    return url && url.indexOf('cleanup=true') !== -1;
  }

  function interceptUploads() {
    var origFetch = window.fetch;
    window.fetch = function() {
      var url = (arguments[0] && arguments[0].toString()) || '';
      var args = arguments;

      if (url.indexOf('/upload') !== -1 && url.indexOf('chunkStatus') === -1) {
        if (isCleanupUrl(url)) {
          console.log('[UploadResume] Blocked cleanup request — chunks preserved for retry:', url);
          return Promise.resolve(new Response(JSON.stringify({ success: true, blocked: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          }));
        }

        if (isPaused) {
          return Promise.reject(new Error('Upload paused by user'));
        }

        uploadCount++;
        showPanel();

        var chunkInfo = extractChunkInfo(args, true);
        if (chunkInfo.chunkIndex !== null) {
          updateChunkProgress(chunkInfo.chunkIndex, chunkInfo.totalChunks);
        }
        setStatus(getChunkStatusText());

        var promise = origFetch.apply(this, args);
        promise.then(function(response) {
          if (url.indexOf('initChunked') !== -1 && response.ok) {
            response.clone().json().then(function(data) {
              if (data.uploadId) {
                console.log('[UploadResume] Saved upload session:', data.uploadId);
              }
            }).catch(function() {});
          }
          uploadCount--;
          if (uploadCount <= 0 && !isPaused) {
            uploadCount = 0;
            chunkProgress = { uploaded: 0, total: 0 };
            setTimeout(function() { hidePanel(); }, 1500);
          }
        }).catch(function(err) {
          uploadCount--;
          if (uploadCount <= 0 && !isPaused) {
            uploadCount = 0;
            chunkProgress = { uploaded: 0, total: 0 };
            hidePanel();
          }
        });
        return promise;
      }
      return origFetch.apply(this, args);
    };

    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url) {
      this._uploadUrl = url;
      return origOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function(data) {
      if (this._uploadUrl && this._uploadUrl.indexOf('/upload') !== -1 &&
          this._uploadUrl.indexOf('chunkStatus') === -1) {
        if (isCleanupUrl(this._uploadUrl)) {
          console.log('[UploadResume] Blocked XHR cleanup request — chunks preserved for retry');
          return;
        }

        if (isPaused) {
          this.abort();
          return;
        }
        uploadCount++;
        showPanel();

        if (data instanceof FormData) {
          var chunkIndex = data.get('chunkIndex');
          var totalChunks = data.get('totalChunks');
          if (chunkIndex !== null && totalChunks !== null) {
            updateChunkProgress(parseInt(chunkIndex), parseInt(totalChunks));
          }
        }
        setStatus(getChunkStatusText());

        var self = this;
        this.addEventListener('loadend', function() {
          uploadCount--;
          if (uploadCount <= 0 && !isPaused) {
            uploadCount = 0;
            chunkProgress = { uploaded: 0, total: 0 };
            setTimeout(function() { hidePanel(); }, 1500);
          }
        });
      }
      return origSend.call(this, data);
    };
  }

  async function queryChunkStatus(uploadId, totalChunks) {
    try {
      var response = await fetch('/upload/chunkStatus?uploadId=' + uploadId + '&totalChunks=' + totalChunks);
      if (response.ok) {
        var data = await response.json();
        return data;
      }
    } catch (e) {
      console.error('[UploadResume] Failed to query chunk status:', e);
    }
    return null;
  }

  function pauseUploads() {
    isPaused = true;
    pauseBtn.style.display = 'none';
    resumeBtn.style.display = 'flex';
    setStatus('已暂停 - 点击继续恢复上传');
    console.log('[UploadResume] Uploads paused');
  }

  function resumeUploads() {
    isPaused = false;
    pauseBtn.style.display = 'flex';
    resumeBtn.style.display = 'none';
    setStatus('正在恢复上传...');
    uploadCount = 0;

    var state = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    var keys = Object.keys(state);
    if (keys.length > 0) {
      var uploadId = keys[keys.length - 1];
      var savedState = state[uploadId];
      if (savedState) {
        queryChunkStatus(uploadId, savedState.totalChunks).then(function(status) {
          if (status && status.success) {
            var uploaded = status.uploadedChunks ? status.uploadedChunks.length : 0;
            var total = status.totalChunks || savedState.totalChunks;
            setStatus('已恢复: ' + uploaded + '/' + total + ' 分块已完成');
            console.log('[UploadResume] Resumed upload:', uploadId, 'Uploaded chunks:', status.uploadedChunks);
          } else {
            setStatus('已恢复上传');
          }
        });
      }
    }

    setTimeout(function() {
      if (uploadCount === 0) {
        hidePanel();
      }
    }, 3000);

    console.log('[UploadResume] Uploads resumed');
  }

  window.UploadResume = {
    queryChunkStatus: queryChunkStatus,
    saveState: saveState,
    getSavedState: getSavedState,
    clearState: clearState,
    isPaused: function() { return isPaused; }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
