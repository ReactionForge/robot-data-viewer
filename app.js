/*
 * Robot Data Viewer v2 — offline TAR player.
 * Native-aspect, seven-channel viewer with clear/compact/adaptive layouts,
 * overview eye-split, fit-to-screen, focus lightbox, frame stepping and
 * global keyboard shortcuts. No backend, no dependency, no board contact.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- i18n
  var I18N = {
    en: {
      brandName: 'Robot Data Viewer', brandSub: 'DATA EXPLORER',
      tabRecordings: 'Recordings', tabLive: 'Live Cameras',
      offline: 'Local files · Offline viewing', openFolder: 'Open folder', openTar: 'Open TAR',
      samples: 'SAMPLES', searchRecording: 'Find a recording...',
      privacy: 'Your recordings stay on this computer.',
      emptyHint: 'Drop a session .tar anywhere on this page to begin',
      estimatedAlignment: 'Estimated alignment', cameraViews: 'Camera views',
      allCameras: 'All cameras', mainCameras: 'Main cameras', tactileCameras: 'Tactile cameras',
      custom: 'Custom', gridPlaceholder: 'Import a session TAR to see all camera views playing in sync',
      visibleChannels: 'Visible channels', channelsWord: 'channels', selectAll: 'Select all', none: 'None',
      layout: 'Grid columns', apply: 'Apply',
      showForce: 'Show estimated force', importForce: 'Import force tracks',
      removeForce: 'Remove saved results for this episode', clearForce: 'Clear all saved force results',
      tactileResponse: 'Tactile response', playing: 'Playing', paused: 'Paused',
      dropTitle: 'Drop session .tar to import',
      dropSub: 'Seven or custom number of camera channels will play in sync',
      loadingTitle: 'Reading session archive…',
      imported: 'Imported {n} camera channel(s)', noVideo: 'No camera video found in this archive.',
      badFormat: 'Unsupported file: please choose a .tar exported from the device.',
      codecWarn: 'This browser cannot decode H.265/HEVC video. Try Microsoft Edge, or Chrome/Edge with HEVC support enabled.',
      recording: 'recording', recordings: 'recordings', channels: 'channels',
      needFolder: 'Choose a folder that contains observation.image.* subfolders.',
      folderLoaded: 'Folder loaded',
      layoutLabel: 'Layout', layoutClear: 'Clear', layoutCompact: 'Compact', layoutSingle: 'One screen', layoutAuto: 'Adaptive',
      egoLabel: 'Overview', egoMerge: 'Merge', egoSplit: 'Split eyes',
      shortcutHint: 'Space play · ←/→ 5s · ,/. frame · F fullscreen · 1–7 focus',
      egoLeft: 'Overview · Left eye', egoRight: 'Overview · Right eye',
      leftEye: 'Left eye', rightEye: 'Right eye',
      zoomFit: 'Fit', lbHint: 'Drag to pan · Esc to close',
      egoSplitUnavailable: 'Overview is not about 32:9 — split eyes unavailable.',
    },
    zh: {
      brandName: '机器人数据查看器', brandSub: '数据浏览器',
      tabRecordings: '录制回放', tabLive: '实时相机',
      offline: '本地文件 · 离线观看', openFolder: '打开文件夹', openTar: '导入 TAR',
      samples: '录制样本', searchRecording: '查找录制…',
      privacy: '您的录制数据仅保留在本机。',
      emptyHint: '将会话 .tar 拖放到页面任意位置即可开始',
      estimatedAlignment: '估算对齐', cameraViews: '相机画面',
      allCameras: '全部相机', mainCameras: '主相机', tactileCameras: '触觉相机',
      custom: '自定义', gridPlaceholder: '导入会话 TAR，即可同步观看所有相机画面',
      visibleChannels: '显示通道', channelsWord: '路', selectAll: '全选', none: '清空',
      layout: '网格列数', apply: '应用',
      showForce: '显示估算力矩', importForce: '导入力矩轨迹',
      removeForce: '清除本次力矩结果', clearForce: '清除所有力矩结果',
      tactileResponse: '触觉响应', playing: '播放中', paused: '已暂停',
      dropTitle: '拖入会话 .tar 进行导入',
      dropSub: '七路或自定义路数的相机画面将同步播放',
      loadingTitle: '正在读取会话数据包…',
      imported: '已导入 {n} 路相机画面', noVideo: '数据包中未找到相机视频。',
      badFormat: '不支持的文件：请选择设备导出的 .tar 数据包。',
      codecWarn: '当前浏览器无法解码 H.265/HEVC 视频。请使用 Microsoft Edge，或已启用 HEVC 支持的 Chrome/Edge。',
      recording: '条录制', recordings: '条录制', channels: '路',
      needFolder: '请选择包含 observation.image.* 子文件夹的目录。',
      folderLoaded: '文件夹已载入',
      layoutLabel: '布局', layoutClear: '清晰', layoutCompact: '紧凑', layoutSingle: '单屏', layoutAuto: '自适应',
      egoLabel: '总览', egoMerge: '合并', egoSplit: '双眼',
      shortcutHint: '空格 播放 · ←/→ 5秒 · ,/. 单帧 · F 全屏 · 1–7 聚焦',
      egoLeft: '总览 · 左眼', egoRight: '总览 · 右眼',
      leftEye: '左眼', rightEye: '右眼',
      zoomFit: '适应', lbHint: '拖动平移 · Esc 关闭',
      egoSplitUnavailable: '总览不是约 32:9 画幅，无法拆分双眼。',
    },
  };

  var lang = 'en';
  function t(key, vars) {
    var s = (I18N[lang] && I18N[lang][key]) || I18N.en[key] || key;
    if (vars) Object.keys(vars).forEach(function (k) {
      s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), vars[k]);
    });
    return s;
  }
  function applyLang() {
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-ph]').forEach(function (el) {
      el.placeholder = t(el.getAttribute('data-i18n-ph'));
    });
    document.getElementById('langBtn').textContent = lang === 'en' ? '中文' : 'EN';
    document.documentElement.lang = lang;
    if (state.channels.length) {
      updateCounts();
      renderPlayState();
    }
  }

  // ---------------------------------------------------------------- refs
  var $ = function (id) { return document.getElementById(id); };
  var el = {
    tarInput: $('tarInput'), folderInput: $('folderInput'),
    openTarBtn: $('openTarBtn'), openFolderBtn: $('openFolderBtn'),
    langBtn: $('langBtn'), collapseBtn: $('collapseBtn'), sidebar: $('sidebar'),
    searchInput: $('searchInput'), recordingCount: $('recordingCount'), recordings: $('recordings'),
    breadcrumb: $('breadcrumb'), episodeTitle: $('episodeTitle'),
    channelCountLabel: $('channelCountLabel'), chipAllCount: $('chipAllCount'),
    chipMainCount: $('chipMainCount'), chipTactileCount: $('chipTactileCount'),
    customChip: $('customChip'), customPanel: $('customPanel'),
    countInput: $('countInput'), channelChecks: $('channelChecks'),
    layoutSelect: $('layoutSelect'), selectAllBtn: $('selectAllBtn'), noneBtn: $('noneBtn'),
    applyCustomBtn: $('applyCustomBtn'),
    layoutSwitch: $('layoutSwitch'), egoSwitch: $('egoSwitch'),
    content: $('content'), mainScroll: $('mainScroll'), cardGrid: $('cardGrid'),
    tactileChannels: $('tactileChannels'),
    playBtn: $('playBtn'), prevBtn: $('prevBtn'), nextBtn: $('nextBtn'),
    frameBackBtn: $('frameBackBtn'), frameFwdBtn: $('frameFwdBtn'), frameLabel: $('frameLabel'),
    seek: $('seek'), curTime: $('curTime'), totTime: $('totTime'),
    playState: $('playState'), playStateText: $('playStateText'), speed: $('speed'),
    fullscreenBtn: $('fullscreenBtn'),
    lightbox: $('lightbox'), lbBackdrop: $('lbBackdrop'), lbName: $('lbName'), lbRes: $('lbRes'),
    lbClose: $('lbClose'), lbStage: $('lbStage'), lbPlay: $('lbPlay'), lbTime: $('lbTime'),
    lbZoom: $('lbZoom'),
    dropOverlay: $('dropOverlay'), loading: $('loading'),
    loadingSub: $('loadingSub'), progressFill: $('progressFill'),
    toast: $('toast'),
  };

  // ---------------------------------------------------------------- state
  var state = {
    channels: [],          // {key,label,group,url,delta,frames,hz,video,width,height}
    videos: [],            // active card <video> elements
    master: null,          // clock source (first rendered video)
    objectUrls: [],
    filter: 'all',
    customKeys: [],
    layout: 'clear',       // clear | compact | single | auto
    gridCols: '4',         // auto | 1 | 2 | 3 | 4 (custom panel)
    splitEgo: false,       // overview eye-split
    egoSplitAllowed: true, // false when source is not ~32:9
    egoReverting: false,
    playing: false,
    duration: 0,
    currentTime: 0,
    fps: 30,
    frameTotal: 0,
    meta: null,
    sessionId: '',
    renderId: 0,
    ticking: false,
    toastTimer: null,
    // lightbox
    lbOpen: false, lbChannel: null, lbEye: null, lbVideo: null, lbMedia: null,
    lbNatW: 0, lbNatH: 0, lbZoom: 'fit', lbTx: 0, lbTy: 0, lbPan: null,
  };

  var LABELS = {
    third_view: ['Overview', '总览'],
    left_wrist_view: ['Left wrist', '左腕'],
    right_wrist_view: ['Right wrist', '右腕'],
    left_wrist_left_tactile: ['Left hand · Left sensor', '左手 · 左传感器'],
    left_wrist_right_tactile: ['Left hand · Right sensor', '左手 · 右传感器'],
    right_wrist_left_tactile: ['Right hand · Left sensor', '右手 · 左传感器'],
    right_wrist_right_tactile: ['Right hand · Right sensor', '右手 · 右传感器'],
  };
  var ORDER = [
    'third_view', 'left_wrist_view', 'right_wrist_view',
    'left_wrist_left_tactile', 'left_wrist_right_tactile',
    'right_wrist_left_tactile', 'right_wrist_right_tactile',
  ];

  function labelFor(key) {
    var pair = LABELS[key];
    if (pair) return lang === 'zh' ? pair[1] : pair[0];
    return key.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  function groupFor(key) {
    if (key.indexOf('tactile') >= 0) return 'tactile';
    return 'main';
  }
  function channelOrder(key) {
    var i = ORDER.indexOf(key);
    return i >= 0 ? i : 100 + key.length;
  }
  function isEgo(c) { return c.key === 'third_view' || /third|ego|fisheye|overview/i.test(c.key); }
  function isWrist(c) { return c.key === 'left_wrist_view' || c.key === 'right_wrist_view' || /wrist/i.test(c.key) && c.group === 'main'; }
  function cardClass(c, eye) {
    if (isEgo(c)) return eye ? 'card-ego-eye' : 'card-ego';
    if (isWrist(c)) return 'card-wrist';
    return 'card-tactile';
  }

  // ---------------------------------------------------------------- utils
  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var m = Math.floor(sec / 60);
    var s = sec - m * 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }
  function toast(msg, kind) {
    el.toast.textContent = msg;
    el.toast.className = 'toast ' + (kind || '');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () { el.toast.classList.add('hidden'); }, 4200);
  }
  function showLoading(on, pct) {
    el.loading.classList.toggle('hidden', !on);
    if (on) {
      el.loadingSub.textContent = Math.round((pct || 0) * 100) + '%';
      el.progressFill.style.width = Math.round((pct || 0) * 100) + '%';
    }
  }
  function storeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function storeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  // ---------------------------------------------------------------- ingest
  function releaseOld() {
    closeLightbox();
    state.videos.forEach(function (v) { try { v.pause(); v.removeAttribute('src'); } catch (e) {} });
    state.objectUrls.forEach(function (u) { URL.revokeObjectURL(u); });
    state.videos = [];
    state.objectUrls = [];
    state.channels = [];
    state.meta = null;
    state.sessionId = '';
    state.duration = 0;
    state.currentTime = 0;
    state.master = null;
    state.renderId++;
  }

  async function parseFirstTimestamp(blob) {
    try {
      var text = await blob.slice(0, 4096).text();
      var lines = text.split(/\r?\n/);
      if (!lines.length) return null;
      var header = lines[0].split(',');
      var idx = header.findIndex(function (h) { return h.trim() === 'timestamp_ms'; });
      if (idx < 0) return null;
      for (var i = 1; i < Math.min(lines.length, 6); i++) {
        var parts = lines[i].split(',');
        if (parts.length <= idx) continue;
        var v = parseFloat(parts[idx]);
        if (!isFinite(v)) continue;
        if (Math.abs(v) > 1e9) v = v / 1e6; // ns -> ms
        return v;
      }
    } catch (e) {}
    return null;
  }

  async function ingestEntries(entries, sourceLabel) {
    showLoading(true, 0.05);
    try {
      // 1. metadata.json
      var metaEntry = null;
      for (var i = 0; i < entries.length; i++) {
        if (/(^|\/)metadata\.json$/i.test(entries[i].name)) { metaEntry = entries[i]; break; }
      }
      var meta = null;
      if (metaEntry) {
        try { meta = JSON.parse(await metaEntry.blob.text()); } catch (e) { meta = null; }
      }

      // 2. camera videos
      var videoEntries = [];
      for (var j = 0; j < entries.length; j++) {
        var name = entries[j].name;
        var m = name.match(/(?:^|\/)observation\.image\.([^/]+)\/video\.mp4$/i);
        if (m) { videoEntries.push({ key: m[1], entry: entries[j] }); continue; }
        var m2 = name.match(/(?:^|\/)([^/]+)\/(?:video|image)\.mp4$/i);
        if (m2 && /camera|view|wrist|tactile|fisheye|eye|ego|hand|image/i.test(m2[1])) {
          videoEntries.push({ key: m2[1], entry: entries[j] });
        }
      }

      // 3. timestamps for alignment badges
      var tsMap = {};
      for (var k = 0; k < entries.length; k++) {
        var tm = entries[k].name.match(/(?:^|\/)observation\.image\.([^/]+)\/timestamps\.csv$/i);
        if (tm) tsMap[tm[1]] = entries[k].blob;
      }
      var deltas = {};
      var tsKeys = Object.keys(tsMap);
      var t0 = null;
      for (var a = 0; a < tsKeys.length; a++) {
        var d = await parseFirstTimestamp(tsMap[tsKeys[a]]);
        if (d !== null) { deltas[tsKeys[a]] = d; t0 = (t0 === null) ? d : Math.min(t0, d); }
      }
      if (t0 !== null) Object.keys(deltas).forEach(function (key) { deltas[key] = deltas[key] - t0; });

      showLoading(true, 0.45);

      if (!videoEntries.length) {
        showLoading(false);
        toast(t('noVideo'), 'error');
        return;
      }

      videoEntries.sort(function (a, b) { return channelOrder(a.key) - channelOrder(b.key); });

      releaseOld();
      state.meta = meta;
      state.sessionId = (meta && (meta.episode_id || meta.task_title)) || sourceLabel || 'session';

      state.channels = videoEntries.map(function (item) {
        var url = URL.createObjectURL(item.entry.blob);
        state.objectUrls.push(url);
        var mod = (meta && meta.modalities && meta.modalities['observation.image.' + item.key]) || {};
        return {
          key: item.key,
          label: labelFor(item.key),
          group: groupFor(item.key),
          url: url,
          delta: deltas[item.key] || 0,
          frames: mod.frames || 0,
          hz: mod.hz_nominal || 0,
          width: 0, height: 0,
          video: null,
        };
      });

      state.customKeys = state.channels.map(function (c) { return c.key; });
      state.filter = 'all';
      document.querySelectorAll('.chip[data-filter]').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-filter') === 'all');
      });
      el.customPanel.classList.add('hidden');
      el.countInput.value = state.channels.length;
      state.fps = state.channels[0].hz || 30;
      state.frameTotal = state.channels[0].frames || 0;

      updateEgoAllowed();
      renderSidebar();
      renderHeader();
      renderChannelChecks();
      renderCards();
      updateCounts();

      showLoading(true, 0.85);
      await Promise.all(state.videos.map(loadVideoMeta));
      state.duration = state.videos.reduce(function (mx, v) {
        return Math.max(mx, isFinite(v.duration) ? v.duration : 0);
      }, 0) || (meta && meta.duration) || 0;
      if (!state.frameTotal) state.frameTotal = Math.round(state.duration * state.fps);
      el.totTime.textContent = fmtTime(state.duration);
      var recTime = el.recordings.querySelector('.rec-bottom > span:last-child');
      if (recTime) recTime.textContent = fmtTime(state.duration);
      updateTimeUI(state.currentTime);
      showLoading(false);

      toast(t('imported', { n: state.channels.length }), 'success');
      playAll();
    } catch (err) {
      showLoading(false);
      toast((err && err.message) || String(err), 'error');
    }
  }

  function loadVideoMeta(v) {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function () { if (!done) { done = true; resolve(); } };
      v.addEventListener('loadedmetadata', finish, { once: true });
      v.addEventListener('error', finish, { once: true });
      setTimeout(finish, 1500);
      if (v.readyState >= 1) finish();
    });
  }

  // ---------------------------------------------------------------- overview split
  function updateEgoAllowed() {
    var ego = state.channels.filter(function (c) { return isEgo(c); })[0];
    var allowed = false;
    if (ego) {
      if (ego.width && ego.height) {
        var ar = ego.width / ego.height;
        allowed = Math.abs(ar - 32 / 9) <= 0.35;
      } else {
        allowed = true; // unknown until metadata — assume split works
      }
    }
    var changed = state.egoSplitAllowed !== allowed;
    state.egoSplitAllowed = allowed;
    if (!allowed && state.splitEgo) state.splitEgo = false;
    syncEgoUI();
    return changed;
  }
  function syncEgoUI() {
    el.egoSwitch.querySelectorAll('[data-ego]').forEach(function (b) {
      var split = b.getAttribute('data-ego') === 'split';
      b.classList.toggle('active', state.splitEgo === split);
      if (split) b.disabled = !state.egoSplitAllowed;
    });
  }
  function setEgoSplit(on, fromUser) {
    if (on && !state.egoSplitAllowed) {
      if (fromUser) toast(t('egoSplitUnavailable'), 'error');
      on = false;
    }
    if (state.splitEgo === on) { syncEgoUI(); return; }
    state.splitEgo = on;
    syncEgoUI();
    renderCards(); // keeps currentTime + playing state
  }

  // ---------------------------------------------------------------- render cards
  function renderSidebar() {
    el.recordings.innerHTML = '';
    var card = document.createElement('div');
    card.className = 'rec active';
    card.innerHTML =
      '<div class="rec-top"><span class="rec-badge"></span><span class="rec-chevron">›</span></div>' +
      '<div class="rec-title"></div><div class="rec-sub"></div>' +
      '<div class="rec-bottom"><span class="rec-channels">◉ <span></span></span><span></span></div>';
    card.querySelector('.rec-badge').textContent = state.sessionId;
    card.querySelector('.rec-title').textContent = (state.meta && (state.meta.task_title || state.meta.task)) || state.sessionId;
    card.querySelector('.rec-sub').textContent = state.sessionId;
    card.querySelector('.rec-channels span').textContent = state.channels.length + ' ' + t('channels');
    card.querySelector('.rec-bottom > span:last-child').textContent = fmtTime(state.duration);
    card.addEventListener('click', function () { el.cardGrid.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
    el.recordings.appendChild(card);
    updateCounts();
  }

  function renderHeader() {
    var parts = state.sessionId.split('/');
    el.breadcrumb.textContent = (parts.length > 1 ? parts.slice(0, -1).join(' / ') + ' / ' : '') + parts[parts.length - 1];
    el.episodeTitle.textContent = parts[parts.length - 1] || state.sessionId;
    var tactile = state.channels.filter(function (c) { return c.group === 'tactile'; }).length;
    el.tactileChannels.textContent = tactile + ' ' + t('channels');
  }

  function updateCounts() {
    var n = state.channels.length;
    var main = state.channels.filter(function (c) { return c.group === 'main'; }).length;
    var tactile = state.channels.filter(function (c) { return c.group === 'tactile'; }).length;
    el.channelCountLabel.textContent = n + ' ' + t('channels');
    el.chipAllCount.textContent = '(' + n + ')';
    el.chipMainCount.textContent = '(' + main + ')';
    el.chipTactileCount.textContent = '(' + tactile + ')';
    el.recordingCount.textContent = (state.channels.length ? 1 : 0) + ' ' + (state.channels.length ? t('recording') : t('recordings'));
    el.tactileChannels.textContent = tactile + ' ' + t('channels');
    if (state.channels.length) el.searchInput.disabled = false;
  }

  function visibleChannels() {
    if (state.filter === 'all') return state.channels;
    if (state.filter === 'main') return state.channels.filter(function (c) { return c.group === 'main'; });
    if (state.filter === 'tactile') return state.channels.filter(function (c) { return c.group === 'tactile'; });
    var set = {};
    state.customKeys.forEach(function (k) { set[k] = true; });
    return state.channels.filter(function (c) { return set[c.key]; });
  }

  function renderChannelChecks() {
    el.channelChecks.innerHTML = '';
    state.channels.forEach(function (c) {
      var lab = document.createElement('label');
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = state.customKeys.indexOf(c.key) >= 0; cb.value = c.key;
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(c.label));
      el.channelChecks.appendChild(lab);
    });
  }

  function buildRenderList() {
    var out = [];
    visibleChannels().forEach(function (c) {
      if (isEgo(c) && state.splitEgo && state.egoSplitAllowed) {
        out.push({ channel: c, eye: 'left', label: t('egoLeft') });
        out.push({ channel: c, eye: 'right', label: t('egoRight') });
      } else {
        out.push({ channel: c, eye: null, label: c.label });
      }
    });
    return out;
  }

  function applyMeta(c, video, wrap, resBadge) {
    if (!video.videoWidth || !video.videoHeight) return;
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    if (!wrap.classList.contains('eye')) {
      wrap.style.setProperty('--ar', c.width + ' / ' + c.height);
    }
    resBadge.textContent = c.width + '×' + c.height;
    if (isEgo(c)) {
      var changed = updateEgoAllowed();
      if (changed && state.egoReverting === false) {
        state.egoReverting = true;
        var rid = state.renderId;
        setTimeout(function () {
          state.egoReverting = false;
          if (rid === state.renderId && !state.egoSplitAllowed && state.splitEgo) renderCards();
        }, 0);
      }
    }
  }

  function renderCards() {
    closeLightbox();
    var savedTime = state.currentTime;
    var wasPlaying = state.playing;
    var rate = parseFloat(el.speed.value) || 1;
    pauseAll();
    state.playing = wasPlaying;

    var rid = ++state.renderId;
    var list = buildRenderList();

    // layout mode + column count
    var single = state.layout === 'single';
    document.querySelector('.app').classList.toggle('single-screen', single);
    el.cardGrid.className = 'card-grid mode-' + state.layout +
      ' cols-' + (state.gridCols === 'auto' ? 'auto' : state.gridCols);
    if (single) {
      var egoCount = list.filter(function (it) { return isEgo(it.channel); }).length;
      var otherCount = list.length - egoCount;
      var cols = Math.max(otherCount, egoCount > 1 ? egoCount : 1, 1);
      el.cardGrid.style.setProperty('--cols', cols);
      el.cardGrid.style.setProperty('--eye-span', Math.max(1, Math.floor(cols / 2)));
    } else {
      el.cardGrid.style.removeProperty('--cols');
      el.cardGrid.style.removeProperty('--eye-span');
    }
    el.cardGrid.innerHTML = '';
    state.videos = [];
    state.master = null;

    if (!list.length) {
      var ph = document.createElement('div');
      ph.className = 'placeholder';
      ph.textContent = t('gridPlaceholder');
      el.cardGrid.appendChild(ph);
      updateTimeUI(savedTime);
      return;
    }

    list.forEach(function (item) {
      var c = item.channel;
      var eye = item.eye;
      var card = document.createElement('div');
      card.className = 'card ' + cardClass(c, eye);
      card.setAttribute('data-key', c.key);
      card.setAttribute('data-eye', eye || 'full');

      // ---- head
      var head = document.createElement('div');
      head.className = 'card-head';
      var dot = document.createElement('span');
      dot.className = 'dot ' + (c.group === 'tactile' ? 'amber' : 'green');
      var name = document.createElement('span');
      name.className = 'name'; name.textContent = item.label; name.title = c.key;
      var res = document.createElement('span');
      res.className = 'badge-res';
      res.textContent = c.width ? c.width + '×' + c.height : '—';

      var actions = document.createElement('div');
      actions.className = 'head-actions';
      if (isEgo(c) && !eye) {
        var eg = document.createElement('div');
        eg.className = 'ego-toggle';
        [['merge', t('egoMerge'), !state.splitEgo], ['split', t('egoSplit'), state.splitEgo]].forEach(function (pair) {
          var b = document.createElement('button');
          b.type = 'button';
          b.textContent = pair[1];
          b.className = pair[2] ? 'active' : '';
          if (pair[0] === 'split') b.disabled = !state.egoSplitAllowed;
          b.title = pair[0] === 'split' ? t('egoSplit') : t('egoMerge');
          b.addEventListener('click', function (e) {
            e.stopPropagation();
            setEgoSplit(pair[0] === 'split', true);
          });
          eg.appendChild(b);
        });
        actions.appendChild(eg);
      }
      if (c.group === 'tactile') {
        var badge = document.createElement('span');
        badge.className = 'badge-camera'; badge.textContent = 'Camera view';
        actions.appendChild(badge);
      }
      var expand = document.createElement('button');
      expand.className = 'expand'; expand.textContent = '⤢';
      expand.title = 'Focus (⤢)';
      expand.addEventListener('click', function (e) { e.stopPropagation(); openLightbox(c, eye); });
      actions.appendChild(expand);

      head.appendChild(dot); head.appendChild(name); head.appendChild(res); head.appendChild(actions);

      // ---- video
      var wrap = document.createElement('div');
      wrap.className = 'card-video';
      if (eye) wrap.classList.add('eye', 'eye-' + eye);
      wrap.style.setProperty('--ar', isEgo(c) && !eye ? '32 / 9' : '16 / 9');
      var video = document.createElement('video');
      video.muted = true; video.playsInline = true; video.preload = 'auto';
      video.src = c.url; video.setAttribute('playsinline', '');
      var errBox = document.createElement('div');
      errBox.className = 'video-error';
      errBox.innerHTML = '<div>⚠</div><div></div>';
      errBox.lastChild.textContent = t('codecWarn');
      wrap.appendChild(video); wrap.appendChild(errBox);
      wrap.addEventListener('click', function () { openLightbox(c, eye); });

      // ---- foot
      var foot = document.createElement('div');
      foot.className = 'card-foot';
      var left = document.createElement('span');
      left.textContent = (c.hz ? c.hz + ' Hz · ' : '') + (c.frames ? c.frames + ' frames' : c.key);
      var right = document.createElement('span');
      right.className = 'delta';
      right.textContent = c.delta ? 'Δ ' + (c.delta > 0 ? '+' : '') + c.delta.toFixed(1) + ' ms' : 'sync';
      foot.appendChild(left); foot.appendChild(right);

      card.appendChild(head); card.appendChild(wrap); card.appendChild(foot);
      el.cardGrid.appendChild(card);

      video._channel = c;
      video._eye = eye;
      c.video = video;
      state.videos.push(video);
      if (!state.master) state.master = video;

      var metaDone = false;
      var onMeta = function () {
        if (metaDone || rid !== state.renderId) return;
        metaDone = true;
        applyMeta(c, video, wrap, res);
        var target = savedTime;
        if (isFinite(video.duration) && video.duration > 0) {
          target = Math.max(0, Math.min(target, video.duration - 0.02));
        }
        try { video.currentTime = target; } catch (e) {}
        video.playbackRate = rate;
        if (wasPlaying) {
          var p = video.play();
          if (p && p.catch) p.catch(function () {});
        }
        updateTimeUI(target);
      };
      video.addEventListener('loadedmetadata', onMeta, { once: true });
      video.addEventListener('error', function () { if (rid === state.renderId) wrap.classList.add('error'); });
      if (video.readyState >= 1) onMeta();
      else setTimeout(onMeta, 1600);
    });

    state.playing = wasPlaying && state.videos.length > 0;
    renderPlayState();
    if (state.playing) ensureTick();
    updateTimeUI(savedTime);
  }

  // ---------------------------------------------------------------- playback
  function syncVideos() {
    return state.lbVideo ? state.videos.concat([state.lbVideo]) : state.videos;
  }
  function currentMasterTime() {
    return state.master ? state.master.currentTime : state.currentTime;
  }

  function playAll() {
    if (!state.videos.length) return;
    state.playing = true;
    var rate = parseFloat(el.speed.value) || 1;
    syncVideos().forEach(function (v) {
      v.playbackRate = rate;
      var p = v.play();
      if (p && p.catch) p.catch(function () {});
    });
    renderPlayState();
    ensureTick();
  }
  function pauseAll() {
    state.playing = false;
    syncVideos().forEach(function (v) { try { v.pause(); } catch (e) {} });
    renderPlayState();
  }
  function seekAll(time) {
    if (!isFinite(time) || time < 0) time = 0;
    if (state.duration) time = Math.min(time, state.duration);
    state.currentTime = time;
    syncVideos().forEach(function (v) {
      try {
        var lim = isFinite(v.duration) && v.duration > 0 ? v.duration - 0.02 : time;
        v.currentTime = Math.min(time, lim);
      } catch (e) {}
    });
    updateTimeUI(time);
  }
  function renderPlayState() {
    el.playBtn.textContent = state.playing ? '❚❚' : '▶';
    el.lbPlay.textContent = state.playing ? '❚❚' : '▶';
    el.playState.classList.toggle('paused', !state.playing);
    el.playStateText.textContent = t(state.playing ? 'playing' : 'paused');
  }
  function fpsNow() { return state.fps || 30; }
  function frameTotal() { return state.frameTotal || Math.round(state.duration * fpsNow()) || 0; }
  function updateTimeUI(ct) {
    if (!isFinite(ct) || ct < 0) ct = 0;
    el.curTime.textContent = fmtTime(ct);
    el.seek.value = state.duration ? (ct / state.duration) * 1000 : 0;
    var total = frameTotal();
    var now = Math.min(total || 999999, Math.floor(ct * fpsNow()) + 1);
    el.frameLabel.textContent = 'frame ' + now + ' / ' + total;
    el.lbTime.textContent = fmtTime(ct) + ' / ' + fmtTime(state.duration);
  }
  function ensureTick() {
    if (state.ticking) return;
    state.ticking = true;
    requestAnimationFrame(tick);
  }
  function tick() {
    if (!state.playing) { state.ticking = false; return; }
    var m = state.master;
    if (m && !m.paused) {
      var ct = m.currentTime;
      state.currentTime = ct;
      syncVideos().forEach(function (v) {
        if (v !== m && Math.abs(v.currentTime - ct) > 0.12) {
          try { v.currentTime = ct; } catch (e) {}
        }
      });
      updateTimeUI(ct);
      if (state.duration && ct >= state.duration - 0.05) pauseAll();
    }
    requestAnimationFrame(tick);
  }
  function stepFrame(dir) {
    var t = currentMasterTime() + dir / fpsNow();
    pauseAll();
    seekAll(Math.max(0, t));
  }
  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
    } else if (document.exitFullscreen) {
      document.exitFullscreen();
    }
  }

  // ---------------------------------------------------------------- lightbox
  function openLightbox(channel, eye) {
    if (!channel) return;
    closeLightbox();
    state.lbOpen = true;
    state.lbChannel = channel;
    state.lbEye = eye || null;
    state.lbZoom = 'fit';
    state.lbTx = 0; state.lbTy = 0;
    el.lightbox.classList.remove('hidden');

    var w = channel.width || 1920;
    var h = channel.height || 1080;
    el.lbName.textContent = eye
      ? channel.label + ' · ' + t(eye === 'left' ? 'leftEye' : 'rightEye')
      : channel.label;
    el.lbRes.textContent = w + '×' + h;

    var media = document.createElement('div');
    media.className = 'lb-media' + (eye ? ' eye eye-' + eye : '');
    var video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.preload = 'auto';
    video.src = channel.url; video.setAttribute('playsinline', '');
    media.appendChild(video);
    el.lbStage.innerHTML = '';
    el.lbStage.appendChild(media);

    state.lbNatW = eye ? w / 2 : w;
    state.lbNatH = h;
    media.style.width = state.lbNatW + 'px';
    media.style.height = state.lbNatH + 'px';
    state.lbVideo = video;
    state.lbMedia = media;

    el.lbZoom.querySelectorAll('.lbz').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-zoom') === 'fit');
    });
    el.lbPlay.textContent = state.playing ? '❚❚' : '▶';
    updateTimeUI(state.currentTime);

    var ready = false;
    var onReady = function () {
      if (ready) return;
      ready = true;
      try { video.currentTime = state.currentTime; } catch (e) {}
      video.playbackRate = parseFloat(el.speed.value) || 1;
      if (state.playing) {
        var p = video.play();
        if (p && p.catch) p.catch(function () {});
      }
      applyLbZoom();
    };
    video.addEventListener('loadedmetadata', onReady, { once: true });
    video.addEventListener('error', function () {
      media.style.outline = '1px solid #7a3734';
    });
    if (video.readyState >= 1) onReady();
    else setTimeout(onReady, 1200);
    applyLbZoom();
  }
  function closeLightbox() {
    if (!state.lbOpen) return;
    if (state.lbVideo) {
      try { state.lbVideo.pause(); state.lbVideo.removeAttribute('src'); } catch (e) {}
    }
    state.lbVideo = null;
    state.lbMedia = null;
    state.lbOpen = false;
    state.lbChannel = null;
    state.lbEye = null;
    state.lbPan = null;
    el.lightbox.classList.add('hidden');
    el.lbStage.innerHTML = '';
  }
  function applyLbZoom() {
    if (!state.lbMedia) return;
    var sw = el.lbStage.clientWidth;
    var sh = el.lbStage.clientHeight;
    var fit = Math.min(sw / state.lbNatW, sh / state.lbNatH);
    var s = state.lbZoom === 'fit' ? fit : parseFloat(state.lbZoom);
    if (!isFinite(s) || s <= 0) s = 1;
    var maxX = Math.max(0, (state.lbNatW * s - sw) / 2 + 40);
    var maxY = Math.max(0, (state.lbNatH * s - sh) / 2 + 40);
    state.lbTx = Math.max(-maxX, Math.min(maxX, state.lbTx));
    state.lbTy = Math.max(-maxY, Math.min(maxY, state.lbTy));
    state.lbMedia.style.transform =
      'translate(-50%, -50%) translate(' + state.lbTx + 'px, ' + state.lbTy + 'px) scale(' + s + ')';
  }

  // ---------------------------------------------------------------- import
  async function importTar(file) {
    if (!file) return;
    if (!/\.tar$/i.test(file.name) && file.type !== 'application/x-tar') {
      toast(t('badFormat'), 'error'); return;
    }
    showLoading(true, 0.02);
    try {
      var entries = await TarReader.readTar(file, function (p) { showLoading(true, p); });
      await ingestEntries(entries, file.name.replace(/\.tar$/i, ''));
    } catch (err) {
      showLoading(false);
      toast((err && err.message) || String(err), 'error');
    }
  }

  async function importFolder(fileList) {
    var files = Array.prototype.slice.call(fileList);
    if (!files.length) return;
    showLoading(true, 0.2);
    try {
      var entries = files.map(function (f) {
        return { name: f.webkitRelativePath || f.name, size: f.size, blob: f };
      });
      await ingestEntries(entries, 'folder');
    } catch (err) {
      showLoading(false);
      toast((err && err.message) || String(err), 'error');
    }
  }

  // ---------------------------------------------------------------- events
  el.openTarBtn.addEventListener('click', function () { el.tarInput.click(); });
  el.tarInput.addEventListener('change', function (e) {
    importTar(e.target.files[0]);
    e.target.value = '';
  });
  el.openFolderBtn.addEventListener('click', function () { el.folderInput.click(); });
  el.folderInput.addEventListener('change', function (e) {
    importFolder(e.target.files);
    e.target.value = '';
  });
  el.langBtn.addEventListener('click', function () {
    lang = lang === 'en' ? 'zh' : 'en';
    applyLang();
    if (state.channels.length) { renderSidebar(); renderCards(); }
  });
  el.collapseBtn.addEventListener('click', function () {
    el.sidebar.classList.toggle('collapsed');
    el.collapseBtn.textContent = el.sidebar.classList.contains('collapsed') ? '⇥' : '⇤';
  });

  // layout switch
  el.layoutSwitch.addEventListener('click', function (e) {
    var b = e.target.closest('[data-layout]');
    if (!b) return;
    state.layout = b.getAttribute('data-layout');
    el.layoutSwitch.querySelectorAll('[data-layout]').forEach(function (x) {
      x.classList.toggle('active', x === b);
    });
    renderCards();
  });
  // overview merge / split (toolbar)
  el.egoSwitch.addEventListener('click', function (e) {
    var b = e.target.closest('[data-ego]');
    if (!b || b.disabled) return;
    setEgoSplit(b.getAttribute('data-ego') === 'split', true);
  });
  window.addEventListener('resize', function () {
    if (state.lbOpen) applyLbZoom();
  });

  document.querySelectorAll('.chip[data-filter]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      state.filter = btn.getAttribute('data-filter');
      document.querySelectorAll('.chip[data-filter]').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      el.customPanel.classList.add('hidden');
      renderCards();
    });
  });
  el.customChip.addEventListener('click', function () {
    el.customPanel.classList.toggle('hidden');
    if (!el.customPanel.classList.contains('hidden')) renderChannelChecks();
  });
  el.selectAllBtn.addEventListener('click', function () {
    state.customKeys = state.channels.map(function (c) { return c.key; });
    el.countInput.value = state.customKeys.length;
    renderChannelChecks();
  });
  el.noneBtn.addEventListener('click', function () {
    state.customKeys = [];
    el.countInput.value = 0;
    renderChannelChecks();
  });
  el.countInput.addEventListener('input', function () {
    var n = Math.max(0, Math.min(state.channels.length, parseInt(el.countInput.value, 10) || 0));
    state.customKeys = state.channels.slice(0, n).map(function (c) { return c.key; });
    renderChannelChecks();
  });
  el.layoutSelect.addEventListener('change', function () {
    state.gridCols = el.layoutSelect.value;
    el.cardGrid.className = 'card-grid mode-' + state.layout +
      ' cols-' + (state.gridCols === 'auto' ? 'auto' : state.gridCols);
  });
  el.applyCustomBtn.addEventListener('click', function () {
    var checks = el.channelChecks.querySelectorAll('input');
    state.customKeys = [];
    checks.forEach(function (cb) { if (cb.checked) state.customKeys.push(cb.value); });
    state.filter = 'custom';
    document.querySelectorAll('.chip[data-filter]').forEach(function (b) { b.classList.remove('active'); });
    el.customChip.classList.add('active');
    renderCards();
    el.customPanel.classList.add('hidden');
  });

  el.playBtn.addEventListener('click', function () { state.playing ? pauseAll() : playAll(); });
  el.prevBtn.addEventListener('click', function () { seekAll(currentMasterTime() - 5); });
  el.nextBtn.addEventListener('click', function () { seekAll(currentMasterTime() + 5); });
  el.frameBackBtn.addEventListener('click', function () { stepFrame(-1); });
  el.frameFwdBtn.addEventListener('click', function () { stepFrame(1); });
  el.seek.addEventListener('input', function () {
    seekAll((parseFloat(el.seek.value) / 1000) * state.duration);
  });
  el.speed.addEventListener('change', function () {
    var rate = parseFloat(el.speed.value) || 1;
    syncVideos().forEach(function (v) { v.playbackRate = rate; });
  });
  el.fullscreenBtn.addEventListener('click', toggleFullscreen);

  // lightbox events
  el.lbClose.addEventListener('click', closeLightbox);
  el.lbBackdrop.addEventListener('click', closeLightbox);
  el.lbPlay.addEventListener('click', function () { state.playing ? pauseAll() : playAll(); });
  el.lbZoom.addEventListener('click', function (e) {
    var b = e.target.closest('[data-zoom]');
    if (!b) return;
    state.lbZoom = b.getAttribute('data-zoom');
    state.lbTx = 0; state.lbTy = 0;
    el.lbZoom.querySelectorAll('.lbz').forEach(function (x) {
      x.classList.toggle('active', x === b);
    });
    applyLbZoom();
  });
  el.lbStage.addEventListener('pointerdown', function (e) {
    if (!state.lbMedia) return;
    state.lbPan = { x: e.clientX, y: e.clientY, tx: state.lbTx, ty: state.lbTy };
    try { el.lbStage.setPointerCapture(e.pointerId); } catch (err) {}
    el.lbStage.classList.add('dragging');
  });
  el.lbStage.addEventListener('pointermove', function (e) {
    if (!state.lbPan) return;
    state.lbTx = state.lbPan.tx + (e.clientX - state.lbPan.x);
    state.lbTy = state.lbPan.ty + (e.clientY - state.lbPan.y);
    applyLbZoom();
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
    el.lbStage.addEventListener(ev, function () {
      state.lbPan = null;
      el.lbStage.classList.remove('dragging');
    });
  });

  // keyboard shortcuts
  window.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName || '').toLowerCase();
    var typing = tag === 'input' || tag === 'select' || tag === 'textarea';
    if (e.key === 'Escape') {
      if (state.lbOpen) closeLightbox();
      else if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen();
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case ' ': e.preventDefault(); state.playing ? pauseAll() : playAll(); break;
      case 'ArrowLeft': e.preventDefault(); seekAll(currentMasterTime() - 5); break;
      case 'ArrowRight': e.preventDefault(); seekAll(currentMasterTime() + 5); break;
      case ',': stepFrame(-1); break;
      case '.': stepFrame(1); break;
      case 'f': case 'F': toggleFullscreen(); break;
      default:
        if (/^[1-7]$/.test(e.key)) {
          var slot = parseInt(e.key, 10) - 1;
          var wantedKey = ORDER[slot];
          var ch = state.channels.filter(function (c) { return c.key === wantedKey; })[0] ||
                   visibleChannels()[slot];
          if (ch) openLightbox(ch, null);
        }
    }
  });

  // Drag & drop
  var dragDepth = 0;
  window.addEventListener('dragenter', function (e) {
    e.preventDefault(); dragDepth++; el.dropOverlay.classList.remove('hidden');
  });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('dragleave', function (e) {
    e.preventDefault(); dragDepth--;
    if (dragDepth <= 0) { dragDepth = 0; el.dropOverlay.classList.add('hidden'); }
  });
  window.addEventListener('drop', function (e) {
    e.preventDefault(); dragDepth = 0; el.dropOverlay.classList.add('hidden');
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    if (/\.tar$/i.test(f.name) || f.type === 'application/x-tar') importTar(f);
    else toast(t('badFormat'), 'error');
  });

  // init from storage
  applyLang();
  updateCounts();
  syncEgoUI();
})();
