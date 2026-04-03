(function () {
  'use strict';

  var TREE_API_URL = '/api/directoryTree?cacheTime=60';
  var STYLE_HOOK = 'cfbed-tree-enhancer';
  var treeCache = null;
  var treeCacheAt = 0;
  var treeCacheTtl = 60 * 1000;
  var activePicker = null;
  var observer = null;
  var enhanceScheduled = false;

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
    if (pageAuthCode) {
      apiUrl += '&authCode=' + encodeURIComponent(pageAuthCode);
    }
    return fetch(apiUrl, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    }).then(function (response) {
      if (!response.ok) {
        var error = new Error('目录树加载失败');
        error.status = response.status;
        throw error;
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
  }

  function closePicker() {
    if (!activePicker) return;
    var overlay = activePicker.overlay;
    activePicker = null;
    if (overlay && overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }
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
    var subtitle = createElement('div', 'cfbed-tree-subtitle', options.subtitle || '选择目标目录后将自动回填到当前输入框');
    var closeButton = createElement('button', 'cfbed-tree-close', '×');
    closeButton.type = 'button';

    header.appendChild(title);
    header.appendChild(closeButton);

    var body = createElement('div', 'cfbed-tree-body');
    var info = createElement('div', 'cfbed-tree-info', subtitle.textContent);
    var selected = createElement('div', 'cfbed-tree-current');
    var content = createElement('div', 'cfbed-tree-content');
    var footer = createElement('div', 'cfbed-tree-footer');
    var cancelButton = createElement('button', 'cfbed-tree-action is-secondary', '取消');
    var confirmButton = createElement('button', 'cfbed-tree-action is-primary', '使用此目录');
    cancelButton.type = 'button';
    confirmButton.type = 'button';

    var state = {
      selected: normalizeNodePath(options.initialPath || ''),
      expanded: {},
      rerender: function () {}
    };

    function updateSelectedText() {
      selected.textContent = '当前选择：' + normalizeForInput(state.selected);
    }

    function renderTree(nodes) {
      content.innerHTML = '';
      var rootButton = createElement('button', 'cfbed-tree-root' + (!state.selected ? ' is-selected' : ''), '根目录 /');
      rootButton.type = 'button';
      rootButton.addEventListener('click', function () {
        state.selected = '';
        updateSelectedText();
        renderTree(nodes);
      });
      content.appendChild(rootButton);

      if (!nodes.length) {
        content.appendChild(createElement('div', 'cfbed-tree-empty', '当前还没有可选目录，将使用根目录。'));
        return;
      }

      nodes.forEach(function (node) {
        content.appendChild(buildTreeItem(node, state, function (path) {
          state.selected = path;
          updateSelectedText();
          renderTree(nodes);
        }));
      });
    }

    state.rerender = function () {
      if (treeCache) {
        renderTree(treeCache);
      }
    };

    footer.appendChild(cancelButton);
    footer.appendChild(confirmButton);
    body.appendChild(info);
    body.appendChild(selected);
    body.appendChild(content);
    dialog.appendChild(header);
    dialog.appendChild(body);
    dialog.appendChild(footer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    activePicker = { overlay: overlay };

    updateSelectedText();
    content.appendChild(createElement('div', 'cfbed-tree-loading', '正在加载目录树...'));

    closeButton.addEventListener('click', closePicker);
    cancelButton.addEventListener('click', closePicker);
    overlay.addEventListener('click', function (event) {
      if (event.target === overlay) closePicker();
    });
    confirmButton.addEventListener('click', function () {
      options.onConfirm(normalizeForInput(state.selected));
      closePicker();
    });

    fetchTree().then(function (nodes) {
      renderTree(nodes);
      updateSelectedText();
    }).catch(function (error) {
      var message = '目录树加载失败，请继续手动输入目录';
      if (error && (error.status === 401 || error.status === 403)) {
        message = '当前环境未开放目录树选择，请继续手动输入目录';
      }
      content.innerHTML = '';
      content.appendChild(createElement('div', 'cfbed-tree-empty is-error', message));
    });
  }

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

    // Homepage upload-folder input is handled by event delegation, skip it here
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

  function enhanceUploadInputs() {
    var candidates = document.querySelectorAll('input[placeholder="上传目录"], input[placeholder="请输入上传目录路径"]');
    candidates.forEach(function (input) {
      insertTrigger(input, {
        title: '选择上传目录',
        subtitle: '上传页面与上传设置都会复用同一个目录树选择器。',
        buttonText: '选择上传目录',
        helperText: '可视化浏览已有目录，选择后会自动填充到上传目录输入框。'
      });
    });
  }

  function enhanceMovePrompt() {
    var dialogs = document.querySelectorAll('.el-message-box');
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

  function enhancePage() {
    enhanceUploadInputs();
    enhanceMovePrompt();
  }

  function scheduleEnhance() {
    if (enhanceScheduled) return;
    enhanceScheduled = true;
    requestAnimationFrame(function () {
      enhanceScheduled = false;
      enhancePage();
    });
  }

  function shouldProcessMutations(mutations) {
    return mutations.some(function (mutation) {
      if (!mutation.addedNodes || mutation.addedNodes.length === 0) {
        return false;
      }
      return Array.prototype.some.call(mutation.addedNodes, function (node) {
        return node && node.nodeType === 1;
      });
    });
  }

  // Event delegation: clicking on the homepage .upload-folder input opens the picker
  function initHomepageFolderDelegate() {
    document.addEventListener('click', function (event) {
      if (activePicker) return;
      var target = event.target;
      var folderWrapper = target.closest && target.closest('.upload-folder');
      if (!folderWrapper) return;
      // Ensure it's an el-input upload-folder on the homepage
      if (!folderWrapper.classList.contains('el-input')) return;
      event.preventDefault();
      event.stopPropagation();
      var input = folderWrapper.querySelector('input');
      openPicker({
        title: '选择上传目录',
        subtitle: '选择目录后将自动填充到上传目录输入框。',
        initialPath: getInputValue(input),
        onConfirm: function (value) {
          var liveInput = folderWrapper.querySelector('input') || input;
          setNativeInputValue(liveInput, value);
        }
      });
    }, true);
  }

  function init() {
    initHomepageFolderDelegate();
    enhancePage();
    observer = new MutationObserver(function (mutations) {
      if (shouldProcessMutations(mutations)) {
        scheduleEnhance();
      }
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
      closePicker();
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
