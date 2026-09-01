(function () {
  'use strict';

  var TREE_API_URL = '/api/directoryTree?cacheTime=60';
  var STYLE_HOOK = 'cfbedTreeEnhancer';
  var treeCache = null;
  var treeCacheAt = 0;
  var treeCacheTtl = 60 * 1000;
  // 多个目录选择器可能在同一帧内同时打开；复用同一请求，避免重复拉取目录树。
  var treeFetchPromise = null;
  var treeFetchKey = '';
  var activeDropdown = null;
  var observer = null;
  var enhanceScheduled = false;
  // 目录列表密码（后端启用门控后查看已有目录需要）；仅保存在内存，刷新页面后需重新输入
  var directoryPassword = '';

  function isPasswordRequiredError(err) {
    return !!(err && err.code === 'directory_password_required');
  }

  // 后台"目录候选项"开关关闭时，/api/directoryTree 返回 403
  function isDirectoryDisabledError(err) {
    return !!(err && err.code === 'directory_suggestions_disabled');
  }

  function invalidateTreeCache() {
    treeCache = null;
    treeCacheAt = 0;
  }

  function normalizeForInput(path) {
    if (!path || path === '/') return '/';
    var normalized = String(path).replace(/^\/+/, '').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
    return normalized ? '/' + normalized + '/' : '/';
  }

  function normalizeNodePath(path) {
    if (!path) return '';
    return String(path).replace(/^\/+/, '').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  }

  function getInputValue(input) {
    return normalizeForInput(input && typeof input.value === 'string' ? input.value : '/');
  }

  function setNativeInputValue(input, value) {
    if (!input) return;
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    if (setter && setter.set) {
      setter.set.call(input, value);
    } else {
      input.value = value;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function resolveLiveInput(input) {
    if (!input) return null;
    if (document.contains(input)) return input;
    var wrapper = input.closest && input.closest('.el-input');
    if (wrapper && document.contains(wrapper)) {
      var nestedInput = wrapper.querySelector('input');
      if (nestedInput) return nestedInput;
    }
    return null;
  }

  function createTriggerButton(text) {
    var button = createElement('button', 'cfbed-tree-inline-button', text || '目录树选择');
    button.type = 'button';
    return button;
  }

  function bindTrigger(button, input, options) {
    button.addEventListener('click', function () {
      var liveInput = resolveLiveInput(input) || input;
      openPicker({
        title: options.title,
        subtitle: options.subtitle,
        initialPath: getInputValue(liveInput),
        onConfirm: function (value) {
          var confirmInput = resolveLiveInput(liveInput) || resolveLiveInput(input) || input;
          setNativeInputValue(confirmInput, value);
        }
      });
    });
  }

  function createElement(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (typeof text === 'string') el.textContent = text;
    return el;
  }

  function fetchTree() {
    if (treeCache && Date.now() - treeCacheAt < treeCacheTtl) {
      return Promise.resolve(treeCache);
    }
    var apiUrl = TREE_API_URL;
    var pageAuthCode = new URLSearchParams(window.location.search).get('authCode');
    var cookieMatch = document.cookie.match(/(^| )authCode=([^;]+)/);
    var authCode = pageAuthCode || (cookieMatch ? decodeURIComponent(cookieMatch[2]) : '');
    if (authCode) {
      apiUrl += '&authCode=' + encodeURIComponent(authCode);
    }
    var headers = {
      Accept: 'application/json',
      authCode: authCode
    };
    if (directoryPassword) {
      headers['X-Directory-Password'] = directoryPassword;
    }
    var requestKey = apiUrl + '|' + directoryPassword;
    if (treeFetchPromise && treeFetchKey === requestKey) {
      return treeFetchPromise;
    }

    var request = fetch(apiUrl, {
      method: 'GET',
      credentials: 'same-origin',
      headers: headers
    }).then(function (response) {
      if (!response.ok) {
        if (response.status === 401) {
          // 区分"目录密码门控 401"（JSON 标记）与"未登录 401"（纯文本）
          return response.json().catch(function () { return null; }).then(function (data) {
            if (data && data.error === 'directory_password_required') {
              var pwdError = new Error('directory_password_required');
              pwdError.code = 'directory_password_required';
              throw pwdError;
            }
            var error = new Error('目录树加载失败');
            error.status = response.status;
            throw error;
          });
        }
        if (response.status === 403) {
          // 目录候选项开关关闭：显示禁用提示，隐藏已有目录
          var disabledError = new Error('directory_suggestions_disabled');
          disabledError.code = 'directory_suggestions_disabled';
          disabledError.status = response.status;
          throw disabledError;
        }
        var err = new Error('目录树加载失败');
        err.status = response.status;
        throw err;
      }
      return response.json();
    }).then(function (data) {
      if (Array.isArray(data)) {
        treeCache = data;
      } else if (Array.isArray(data && data.tree)) {
        treeCache = data.tree;
      } else {
        treeCache = [];
      }
      treeCacheAt = Date.now();
      return treeCache;
    });

    treeFetchKey = requestKey;
    treeFetchPromise = request;
    request.then(function () {
      if (treeFetchPromise === request) treeFetchPromise = null;
    }, function () {
      if (treeFetchPromise === request) treeFetchPromise = null;
    });
    return request;
  }

  // ── Directory password unlock UI（dropdown 与 modal picker 共用）──

  function renderPasswordUnlock(container, options) {
    container.innerHTML = '';
    var wrap = createElement('div', 'cfbed-dir-unlock');
    wrap.appendChild(createElement('div', 'cfbed-dir-unlock-title', '查看已有目录需要密码'));
    wrap.appendChild(createElement('div', 'cfbed-dir-unlock-desc', '输入目录密码即可浏览已有目录；也可跳过此步，直接手动输入目录路径。'));

    var input = document.createElement('input');
    input.type = 'password';
    input.className = 'cfbed-dir-unlock-input';
    input.placeholder = '目录密码';
    input.autocomplete = 'off';
    wrap.appendChild(input);

    var msg = createElement('div', 'cfbed-dir-unlock-msg', options.wrong ? '密码错误，请重试' : '');
    if (options.wrong) msg.classList.add('is-error');
    wrap.appendChild(msg);

    var actions = createElement('div', 'cfbed-dir-unlock-actions');
    var unlockButton = createElement('button', 'cfbed-tree-action is-primary', '解锁');
    unlockButton.type = 'button';
    actions.appendChild(unlockButton);
    wrap.appendChild(actions);

    container.appendChild(wrap);

    function attemptUnlock() {
      var value = input.value.trim();
      if (!value) {
        input.focus();
        return;
      }
      directoryPassword = value;
      invalidateTreeCache();
      unlockButton.disabled = true;
      unlockButton.textContent = '解锁中...';
      fetchTree().then(function (nodes) {
        options.onUnlocked(nodes);
      }).catch(function (err) {
        unlockButton.disabled = false;
        unlockButton.textContent = '解锁';
        if (isPasswordRequiredError(err)) {
          // 密码错误：保留输入内容便于修改，仅重渲染提示
          renderPasswordUnlock(container, Object.assign({}, options, { wrong: true }));
          var newInput = container.querySelector('.cfbed-dir-unlock-input');
          if (newInput) {
            newInput.value = value;
            newInput.focus();
          }
        } else {
          container.innerHTML = '';
          container.appendChild(createElement('div', 'cfbed-dd-msg', '目录列表加载失败，请直接输入'));
        }
      });
    }

    unlockButton.addEventListener('click', attemptUnlock);
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') attemptUnlock();
    });
    setTimeout(function () { input.focus(); }, 50);
  }

  // ── Inline dropdown (for homepage .upload-folder) ──

  function closeDropdown() {
    if (!activeDropdown) return;
    var el = activeDropdown.el;
    activeDropdown = null;
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
    }
  }

  function buildDropdownItem(node, depth, onSelect) {
    var item = createElement('div', 'cfbed-dd-item');
    item.style.paddingLeft = (8 + depth * 16) + 'px';
    var icon = createElement('span', 'cfbed-dd-icon', '📁');
    var label = createElement('span', 'cfbed-dd-label', node.title || node.label || node.name || '');
    item.appendChild(icon);
    item.appendChild(label);

    var cleanPath = normalizeNodePath(node.path || node.value || node.key || '');
    item.addEventListener('click', function (e) {
      e.stopPropagation();
      onSelect(cleanPath);
    });

    var fragment = document.createDocumentFragment();
    fragment.appendChild(item);

    if (Array.isArray(node.children) && node.children.length > 0) {
      node.children.forEach(function (child) {
        fragment.appendChild(buildDropdownItem(child, depth + 1, onSelect));
      });
    }

    return fragment;
  }

  function openDropdown(anchor, onSelect, currentValue) {
    closeDropdown();

    var dropdown = createElement('div', 'cfbed-dd');
    var list = createElement('div', 'cfbed-dd-list');

    // Root option
    var rootItem = createElement('div', 'cfbed-dd-item cfbed-dd-root');
    rootItem.appendChild(createElement('span', 'cfbed-dd-icon', '🏠'));
    rootItem.appendChild(createElement('span', 'cfbed-dd-label', '根目录 /'));
    rootItem.addEventListener('click', function (e) {
      e.stopPropagation();
      onSelect('');
    });
    list.appendChild(rootItem);

    // Loading state
    var loading = createElement('div', 'cfbed-dd-msg', '加载中...');
    list.appendChild(loading);

    dropdown.appendChild(list);

    // Position below anchor, match its width
    var rect = anchor.getBoundingClientRect();
    var ddWidth = Math.max(rect.width, 160);
    dropdown.style.position = 'fixed';
    dropdown.style.top = (rect.bottom + 6) + 'px';
    dropdown.style.right = (window.innerWidth - rect.right) + 'px';
    dropdown.style.width = ddWidth + 'px';

    document.body.appendChild(dropdown);
    var dropdownState = { el: dropdown };
    activeDropdown = dropdownState;

    function isCurrentDropdown() {
      return activeDropdown === dropdownState;
    }

    function renderNodes(nodes) {
      if (!isCurrentDropdown()) return;
      list.innerHTML = '';
      // Root option
      var rootItem = createElement('div', 'cfbed-dd-item cfbed-dd-root');
      rootItem.appendChild(createElement('span', 'cfbed-dd-icon', '🏠'));
      rootItem.appendChild(createElement('span', 'cfbed-dd-label', '根目录 /'));
      rootItem.addEventListener('click', function (e) {
        e.stopPropagation();
        onSelect('');
      });
      list.appendChild(rootItem);

      if (!nodes.length) {
        list.appendChild(createElement('div', 'cfbed-dd-msg', '暂无目录'));
        return;
      }
      nodes.forEach(function (node) {
        list.appendChild(buildDropdownItem(node, 0, onSelect));
      });
    }

    fetchTree().then(renderNodes).catch(function (err) {
      if (!isCurrentDropdown()) return;
      if (isPasswordRequiredError(err)) {
        // 需要目录密码：dropdown 内渲染解锁 UI（输入框本身不受影响，仍可手动填写）
        list.innerHTML = '';
        renderPasswordUnlock(list, { onUnlocked: renderNodes });
        return;
      }
      if (isDirectoryDisabledError(err)) {
        // 目录候选项开关关闭：隐藏已有目录，提示直接输入
        list.innerHTML = '';
        list.appendChild(createElement('div', 'cfbed-dd-msg', '目录选择已禁用，请直接输入路径'));
        return;
      }
      list.innerHTML = '';
      list.appendChild(createElement('div', 'cfbed-dd-msg', '加载失败'));
    });
  }

  // ── Modal picker (for settings/move dialogs) ──

  function closePicker() {
    closeDropdown();
  }

  function buildTreeItem(node, state, onSelect) {
    var item = createElement('div', 'cfbed-tree-item');
    var line = createElement('button', 'cfbed-tree-line');
    line.type = 'button';

    var cleanPath = normalizeNodePath(node.path || node.value || node.key || '');
    var hasChildren = Array.isArray(node.children) && node.children.length > 0;
    var expanded = !!state.expanded[cleanPath];
    var isSelected = state.selected === cleanPath;

    var toggle = createElement('span', 'cfbed-tree-toggle' + (hasChildren ? '' : ' is-empty'), hasChildren ? (expanded ? '▾' : '▸') : '·');
    var label = createElement('span', 'cfbed-tree-label', node.title || node.label || node.name || cleanPath || '未命名目录');
    var path = createElement('span', 'cfbed-tree-path', normalizeForInput(cleanPath));

    if (isSelected) item.classList.add('is-selected');

    line.appendChild(toggle);
    line.appendChild(label);
    line.appendChild(path);
    line.addEventListener('click', function () {
      state.selected = cleanPath;
      if (hasChildren) {
        state.expanded[cleanPath] = true;
      }
      onSelect(cleanPath);
    });

    item.appendChild(line);

    if (hasChildren) {
      toggle.addEventListener('click', function (event) {
        event.stopPropagation();
        state.expanded[cleanPath] = !state.expanded[cleanPath];
        state.rerender();
      });
      if (expanded) {
        var children = createElement('div', 'cfbed-tree-children');
        node.children.forEach(function (child) {
          children.appendChild(buildTreeItem(child, state, onSelect));
        });
        item.appendChild(children);
      }
    }

    return item;
  }

  function openPicker(options) {
    closePicker();

    var overlay = createElement('div', 'cfbed-tree-overlay');
    var dialog = createElement('div', 'cfbed-tree-dialog');
    var header = createElement('div', 'cfbed-tree-header');
    var title = createElement('div', 'cfbed-tree-title', options.title || '选择目录');
    var closeButton = createElement('button', 'cfbed-tree-close', '×');
    closeButton.type = 'button';
    header.appendChild(title);
    header.appendChild(closeButton);

    var inputArea = createElement('div', 'cfbed-tree-input-area');
    var manualInput = document.createElement('input');
    manualInput.type = 'text';
    manualInput.className = 'cfbed-tree-manual-input';
    manualInput.placeholder = '输入目录路径，如 /photos/2024/';
    manualInput.value = normalizeForInput(options.initialPath || '');
    inputArea.appendChild(manualInput);

    var content = createElement('div', 'cfbed-tree-content');
    var footer = createElement('div', 'cfbed-tree-footer');
    var cancelButton = createElement('button', 'cfbed-tree-action is-secondary', '取消');
    var confirmButton = createElement('button', 'cfbed-tree-action is-primary', '确定');
    cancelButton.type = 'button';
    confirmButton.type = 'button';
    footer.appendChild(cancelButton);
    footer.appendChild(confirmButton);

    var state = {
      selected: normalizeNodePath(options.initialPath || ''),
      expanded: {},
      rerender: function () {}
    };

    function syncInputToState() {
      manualInput.value = normalizeForInput(state.selected);
    }

    function renderTree(nodes) {
      content.innerHTML = '';
      var rootButton = createElement('button', 'cfbed-tree-root' + (!state.selected ? ' is-selected' : ''));
      rootButton.type = 'button';
      rootButton.innerHTML = '<span class="cfbed-dd-icon">🏠</span><span>根目录 /</span>';
      rootButton.addEventListener('click', function () {
        state.selected = '';
        syncInputToState();
        renderTree(nodes);
      });
      content.appendChild(rootButton);

      if (!nodes.length) {
        content.appendChild(createElement('div', 'cfbed-tree-empty', '暂无已有目录，可直接输入'));
        return;
      }

      nodes.forEach(function (node) {
        content.appendChild(buildTreeItem(node, state, function (path) {
          state.selected = path;
          syncInputToState();
          renderTree(nodes);
        }));
      });
    }

    state.rerender = function () {
      if (treeCache) renderTree(treeCache);
    };

    dialog.appendChild(header);
    dialog.appendChild(inputArea);
    dialog.appendChild(content);
    dialog.appendChild(footer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    activeDropdown = { el: overlay };

    content.appendChild(createElement('div', 'cfbed-dd-msg', '加载中...'));

    closeButton.addEventListener('click', closePicker);
    cancelButton.addEventListener('click', closePicker);
    overlay.addEventListener('click', function (event) {
      if (event.target === overlay) closePicker();
    });
    manualInput.addEventListener('input', function () {
      state.selected = normalizeNodePath(manualInput.value);
    });
    confirmButton.addEventListener('click', function () {
      var value = manualInput.value.trim();
      options.onConfirm(!value || value === '/' ? '/' : normalizeForInput(value));
      closePicker();
    });

    fetchTree().then(function (nodes) {
      renderTree(nodes);
    }).catch(function (err) {
      content.innerHTML = '';
      if (isPasswordRequiredError(err)) {
        // 需要目录密码：内容区渲染解锁 UI；顶部手动输入框不受影响，仍可直接填写
        renderPasswordUnlock(content, { onUnlocked: renderTree });
        return;
      }
      if (isDirectoryDisabledError(err)) {
        // 目录候选项开关关闭：隐藏已有目录，提示直接输入
        content.appendChild(createElement('div', 'cfbed-tree-empty', '目录选择已禁用，请直接输入路径'));
        return;
      }
      content.appendChild(createElement('div', 'cfbed-dd-msg', '目录列表加载失败，请直接输入'));
    });

    setTimeout(function () { manualInput.focus(); manualInput.select(); }, 50);
  }

  // ── Enhance non-homepage inputs (settings, move dialogs) ──

  function insertTrigger(input, options) {
    if (!input || input.dataset[STYLE_HOOK]) return;
    var wrapper = input.closest('.el-input') || input.parentElement;
    if (!wrapper || !wrapper.parentElement) return;

    var control = wrapper.querySelector('.el-input__wrapper') || wrapper;

    if (control.querySelector && control.querySelector('.cfbed-tree-inline-button')) {
      input.dataset[STYLE_HOOK] = 'true';
      return;
    }

    var nextSibling = wrapper.nextElementSibling;
    if (nextSibling && nextSibling.classList && nextSibling.classList.contains('cfbed-tree-inline-trigger')) {
      input.dataset[STYLE_HOOK] = 'true';
      return;
    }

    // Homepage upload-folder input is handled by event delegation
    var isHomepageFolder = wrapper.classList && wrapper.classList.contains('upload-folder');
    if (isHomepageFolder) {
      input.dataset[STYLE_HOOK] = 'true';
      return;
    }

    if (control.classList && control.classList.contains('el-input__wrapper')) {
      control.classList.add('cfbed-tree-input-merged');
      var inlineButton = createTriggerButton(options.buttonText || '目录树选择');
      inlineButton.classList.add('is-inline-attached');
      control.appendChild(inlineButton);
      input.dataset[STYLE_HOOK] = 'true';
      bindTrigger(inlineButton, input, options);
      return;
    }

    var container = createElement('div', 'cfbed-tree-inline-trigger');
    var button = createTriggerButton(options.buttonText || '目录树选择');
    container.appendChild(button);
    if (options.helperText) {
      container.appendChild(createElement('div', 'cfbed-tree-inline-helper', options.helperText));
    }
    wrapper.parentElement.insertBefore(container, wrapper.nextSibling);
    input.dataset[STYLE_HOOK] = 'true';
    bindTrigger(button, input, options);
  }

  function queryCandidates(root, selector) {
    var candidates = [];
    var seen = [];
    function add(element) {
      if (!element || seen.indexOf(element) !== -1) return;
      seen.push(element);
      candidates.push(element);
    }

    if (!root || root.nodeType === 9) {
      document.querySelectorAll(selector).forEach(add);
      return candidates;
    }

    if (root.nodeType !== 1) return candidates;
    if (root.matches && root.matches(selector)) add(root);
    if (root.closest) add(root.closest(selector));
    if (root.querySelectorAll) root.querySelectorAll(selector).forEach(add);
    return candidates;
  }

  function enhanceUploadInputs(root) {
    var candidates = queryCandidates(root, 'input[placeholder="上传目录"], input[placeholder="请输入上传目录路径"]');
    candidates.forEach(function (input) {
      insertTrigger(input, {
        title: '选择上传目录',
        subtitle: '选择目录后将自动填充。',
        buttonText: '选择上传目录',
        helperText: '可视化浏览已有目录，选择后会自动填充到上传目录输入框。'
      });
    });
  }

  function enhanceMovePrompt(root) {
    var dialogs = queryCandidates(root, '.el-message-box');
    dialogs.forEach(function (dialog) {
      if (dialog.dataset[STYLE_HOOK]) return;
      var title = dialog.querySelector('.el-message-box__title');
      if (!title || title.textContent.indexOf('移动') === -1) return;
      var input = dialog.querySelector('.el-message-box__input input');
      if (!input) return;
      dialog.dataset[STYLE_HOOK] = 'true';
      insertTrigger(input, {
        title: '选择目标目录',
        subtitle: '移动文件或文件夹时，可直接从现有目录树中选择目标位置。',
        buttonText: '选择目标目录',
        helperText: '仍然可以手动编辑路径；目录树选择仅用于更直观地挑选目标目录。'
      });
    });
  }

  function enhancePage(roots) {
    if (!roots || !roots.length) {
      enhanceUploadInputs(document);
      enhanceMovePrompt(document);
      return;
    }
    roots.forEach(function (root) {
      enhanceUploadInputs(root);
      enhanceMovePrompt(root);
    });
  }

  var pendingEnhanceRoots = [];

  function scheduleEnhance(roots) {
    if (roots && roots.length) {
      roots.forEach(function (root) {
        if (root && pendingEnhanceRoots.indexOf(root) === -1) pendingEnhanceRoots.push(root);
      });
    }
    if (enhanceScheduled) return;
    enhanceScheduled = true;
    requestAnimationFrame(function () {
      enhanceScheduled = false;
      var rootsToProcess = pendingEnhanceRoots;
      pendingEnhanceRoots = [];
      enhancePage(rootsToProcess);
    });
  }

  function mutationRoots(mutations) {
    var roots = [];
    mutations.forEach(function (mutation) {
      if (!mutation.addedNodes || mutation.addedNodes.length === 0) return;
      Array.prototype.forEach.call(mutation.addedNodes, function (node) {
        if (node && node.nodeType === 1 && roots.indexOf(node) === -1) roots.push(node);
      });
    });
    return roots;
  }

  // ── Event delegation for homepage .upload-folder ──

  function initHomepageFolderDelegate() {
    document.addEventListener('click', function (event) {
      // Close dropdown if clicking outside
      if (activeDropdown && activeDropdown.el && !activeDropdown.el.classList.contains('cfbed-tree-overlay')) {
        var ddEl = activeDropdown.el;
        if (!ddEl.contains(event.target)) {
          var folderWrapper = event.target.closest && event.target.closest('.upload-folder');
          if (!folderWrapper) {
            closeDropdown();
            return;
          }
        }
      }

      var target = event.target;
      var folderWrapper = target.closest && target.closest('.upload-folder');
      if (!folderWrapper) return;
      if (!folderWrapper.classList.contains('el-input')) return;

      // If dropdown already open, don't reopen
      if (activeDropdown && activeDropdown.el && activeDropdown.el.classList.contains('cfbed-dd')) return;

      event.preventDefault();
      event.stopPropagation();

      var input = folderWrapper.querySelector('input');
      openDropdown(folderWrapper, function (path) {
        var liveInput = folderWrapper.querySelector('input') || input;
        setNativeInputValue(liveInput, normalizeForInput(path));
        closeDropdown();
      }, getInputValue(input));
    }, true);
  }

  function init() {
    initHomepageFolderDelegate();
    enhancePage();
    observer = new MutationObserver(function (mutations) {
      var roots = mutationRoots(mutations);
      if (roots.length) scheduleEnhance(roots);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  window.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      closeDropdown();
    }
  });

  window.CFBedDirectoryTreeEnhancer = {
    openPicker: openPicker,
    closePicker: closePicker,
    refresh: function () {
      treeCache = null;
      treeCacheAt = 0;
      enhancePage();
    }
  };
})();
