/* Offline recording workspace and playback controller. */
(() => {
  'use strict';

  const A = window.RecordingAnalysis;
  const $ = id => document.getElementById(id);
  const all = selector => [...document.querySelectorAll(selector)];
  const known = {
    third_view: 'overview', left_wrist_view: 'wristLeft', right_wrist_view: 'wristRight',
    left_wrist_left_tactile: 'tactileLL', left_wrist_right_tactile: 'tactileLR',
    right_wrist_left_tactile: 'tactileRL', right_wrist_right_tactile: 'tactileRR'
  };
  const order = Object.keys(known);
  const state = {
    sessions: [], session: null, view: 'cameras', time: 0, duration: 0, playing: false, playbackRate: 1,
    anchorTime: 0, anchorAt: 0, lastUpdate: 0, lastSync: 0, raf: 0, chartRaf: 0,
    tiles: [], focus: null, busy: false, dragDepth: 0, toastTimer: 0, audio: false
  };

  function saved(key, fallback) {
    try { return localStorage.getItem('rdv.' + key) || fallback; } catch { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem('rdv.' + key, value); } catch {}
  }

  const prefs = {
    lang: saved('lang', 'zh') === 'en' ? 'en' : 'zh',
    theme: saved('theme', 'light') === 'dark' ? 'dark' : 'light',
    layout: saved('layout', 'clear'),
    linkedLayout: saved('linkedLayout', 'single'),
    sync: saved('sync', 'capture') === 'video' ? 'video' : 'capture'
  };
  if (!['clear', 'compact', 'single', 'auto'].includes(prefs.layout)) prefs.layout = 'clear';
  if (!['clear', 'compact', 'single', 'auto'].includes(prefs.linkedLayout)) prefs.linkedLayout = 'single';
  const currentLayout = () => state.view === 'linked' ? prefs.linkedLayout : prefs.layout;

  function t(key, values = {}) {
    const template = window.ViewerStrings[key]?.[prefs.lang === 'en' ? 1 : 0] || key;
    return template.replace(/\{(\w+)\}/g, (match, name) => values[name] ?? match);
  }
  function describe(element, title) {
    element.title = title;
    element.setAttribute('aria-label', title);
  }
  function icon(name) {
    return '<svg class="icon" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  }
  function localize() {
    document.documentElement.lang = prefs.lang === 'zh' ? 'zh-CN' : 'en';
    all('[data-i18n]').forEach(node => { node.textContent = t(node.dataset.i18n); });
    all('[data-title]').forEach(node => describe(node, t(node.dataset.title)));
    all('[data-placeholder]').forEach(node => { node.placeholder = t(node.dataset.placeholder); });
    $('langBtn').textContent = prefs.lang === 'zh' ? 'EN' : '中文';
    renderSidebar();
    renderTransport();
    if (state.session) {
      renderChecks();
      renderCards();
      renderAnalysis();
    }
    workspace.render();
    workspace.emit('locale');
  }
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const numericFormats = new Map();
  function number(value, digits = 2) {
    if (value == null) return '—';
    const lang = document.documentElement.lang;
    const key = lang + ':' + digits;
    if (!numericFormats.has(key)) numericFormats.set(key, new Intl.NumberFormat(lang, { maximumFractionDigits: digits }));
    return numericFormats.get(key).format(value);
  }
  const ms = value => value == null ? '—' : number(value, 2) + ' ms';
  const label = channel => Object.hasOwn(known, channel.key) ? t(known[channel.key]) : channel.key.replace(/_/g, ' ');
  const isOverview = channel => /^(third_view)$|ego|fisheye|overview/i.test(channel.key);
  const isStereo = channel => !!channel.width && Math.abs(channel.width / channel.height - 32 / 9) <= 0.35;
  const offset = channel => prefs.sync === 'capture' ? channel.offset ?? 0 : 0;
  const rate = () => state.playbackRate;
  const fps = () => state.session?.fps ?? 30;
  const resolution = channel => channel.width ? channel.width + ' × ' + channel.height : '—';

  function timeText(seconds, digits = 1) {
    const unit = 10 ** digits;
    const ticks = Math.max(0, Math.round((seconds || 0) * unit));
    const whole = Math.floor(ticks / unit);
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor(whole / 60) % 60;
    const secs = whole % 60;
    const pad = value => String(value).padStart(2, '0');
    return (hours ? pad(hours) + ':' : '') + pad(minutes) + ':' + pad(secs) + '.' +
      String(ticks % unit).padStart(digits, '0');
  }

  function toast(message, error = false) {
    const status = $('toast');
    clearTimeout(state.toastTimer);
    status.textContent = message;
    status.classList.toggle('error', error);
    status.hidden = false;
    state.toastTimer = setTimeout(() => { status.hidden = true; }, error ? 7000 : 3200);
  }

  function updateTheme() {
    document.documentElement.dataset.theme = prefs.theme;
    $('themeBtn').innerHTML = icon(prefs.theme === 'dark' ? 'sun' : 'moon');
    workspace.emit('theme');
  }

  function loadProgress(name, progress) {
    $('loadingFile').textContent = name;
    if (progress == null) $('progress').removeAttribute('value');
    else $('progress').value = progress;
  }

  async function readRecording(entries, source, { scan = true } = {}) {
    const paths = entries.map(entry => ({ ...entry, name: entry.name.replace(/\\/g, '/').replace(/^\.\//, '') }));
    const metadata = paths.find(entry => /(?:^|\/)metadata\.json$/i.test(entry.name));
    let meta = null;
    let malformed = 0;
    if (metadata) {
      try {
        meta = JSON.parse((await metadata.blob.text()).replace(/^\uFEFF/, ''));
        if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('Invalid metadata object');
      } catch { meta = null; malformed++; }
    }

    const schema = meta?.camera_timestamp_schema?.unit === 'ms' && Number(meta.camera_timestamp_schema.version) >= 3
      ? meta.camera_timestamp_schema : null;
    const videos = new Map();
    for (const entry of paths) {
      const standard = entry.name.match(/^(.*?)(?:observation\.image\.)([^/]+)\/video\.mp4$/i);
      const fallback = entry.name.match(/^(.*\/)?([^/]+)\/(?:video|image)\.mp4$/i);
      if (standard && (!standard[1] || standard[1].endsWith('/'))) {
        videos.set(standard[2], { entry, dir: entry.name.slice(0, entry.name.lastIndexOf('/')) });
      } else if (fallback && /camera|view|wrist|tactile|fisheye|eye|ego|hand|image/i.test(fallback[2]) && !videos.has(fallback[2])) {
        videos.set(fallback[2], { entry, dir: entry.name.slice(0, entry.name.lastIndexOf('/')) });
      }
    }
    if (!videos.size) throw new Error(t('noVideo'));

    const rank = key => order.includes(key) ? order.indexOf(key) : order.length;
    const channels = [...videos].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b)).map(([key, { entry, dir }]) => {
      const mode = meta?.modalities?.['observation.image.' + key] || {};
      return {
        key, dir, blob: entry.blob, group: /tactile/i.test(key) ? 'tactile' : 'main',
        hz: A.positive(mode.hz_nominal ?? mode.fps), frames: A.positive(mode.frames),
        rawHz: A.positive(mode.raw_hz_nominal),
        width: 0, height: 0, duration: 0, timing: null, rawTiming: null, offset: null, url: null, video: null
      };
    });
    const files = new Map(paths.map(entry => [entry.name.toLowerCase(), entry]));
    const timestampNames = new Set();
    const timestampTables = [];
    for (const channel of channels) {
      for (const [file, type, nominal] of [['timestamps.csv', 'timing', channel.hz], ['timestamps_raw.csv', 'rawTiming', channel.rawHz]]) {
        const entry = files.get((channel.dir + '/' + file).toLowerCase());
        if (!entry) continue;
        timestampNames.add(entry.name);
        try {
          const { timing, table } = A.readTiming(await entry.blob.text(), nominal, schema);
          channel[type] = timing;
          const flagsOnly = table.headers.length === 2 && table.headers.some(header => header.toLowerCase() === 'is_new');
          if (type === 'timing' && table.headers.length > 1 && !flagsOnly) {
            timestampTables.push({ table, name: entry.name, channel });
          }
        } catch { malformed++; }
      }
    }

    const alignment = A.alignChannels(channels);
    const reference = channels.filter(channel => channel.offset !== null).sort((a, b) => a.offset - b.offset)[0] || channels[0];
    const referenceFps = reference.hz || reference.timing?.hz || A.positive(meta?.fps_config ?? meta?.fps) || 30;
    const signals = [];
    for (const { table, name, channel } of timestampTables) {
      signals.push(...A.readSignals(table, name, channel.hz || referenceFps, alignment.clock, alignment.origin, !!schema, channel.offset ?? 0)
        .map(signal => ({ ...signal, channel })));
    }
    for (const entry of paths) {
      if (!/\.csv$/i.test(entry.name) || timestampNames.has(entry.name)) continue;
      try {
        const [headers = [], ...rows] = A.parseCsv(await entry.blob.text());
        signals.push(...A.readSignals({ headers, rows }, entry.name, referenceFps, alignment.clock, alignment.origin,
          !!schema && /(?:^|\/)observation\./i.test(entry.name)));
      } catch { malformed++; }
    }
    const metadataTitle = [meta?.task_title, meta?.task, meta?.episode_id].find(value => typeof value === 'string' && value.trim());
    const title = metadataTitle || source.replace(/\.tar$/i, '');
    const manifest = window.RobotManifest.manifestEntry(paths);
    const identity = manifest?.name.replace(/(?:^|\/)(?:meta\/)?global_frame_manifest\.jsonl$/i, '').split('/').at(-1);
    const session = {
      source, title, meta, malformed, channels, alignment, reference, fps: referenceFps, signals,
      manifest: manifest?.blob || null, identity,
      time: 0, loop: { a: null, b: null, enabled: false }, filter: 'all', custom: new Set(channels.map(channel => channel.key)),
      columns: 0, split: false, chartMode: 'timing', track: { timing: 0, signal: 0 }
    };
    if (scan) await workspace.scan(session);
    return session;
  }

  async function importRecordings(items) {
    if (!items.length || state.busy) return;
    state.busy = true;
    $('loading').hidden = false;
    $('main').inert = true;
    let newest = null;
    let imported = 0;
    const errors = [];
    try {
      for (const item of items) {
        loadProgress(item.name, item.file ? 0 : null);
        try {
          const entries = item.file
            ? await window.TarReader.readTar(item.file, progress => loadProgress(item.name, progress * 0.85))
            : item.entries;
          loadProgress(item.name, 0.88);
          newest = await readRecording(entries, item.name);
          state.sessions.push(newest);
          imported++;
        } catch (error) {
          errors.push(t('importFailed', { name: item.name, reason: error.message || String(error) }));
        }
      }
      if (newest) {
        $('searchInput').value = '';
        selectSession(newest, true);
      }
      if (errors.length) toast(errors.join('\n'), true);
      else if (imported) toast(t('importDone', { n: imported }));
    } finally {
      state.busy = false;
      $('main').inert = false;
      $('loading').hidden = true;
    }
  }

  function importTar(files) {
    const items = [...files].filter(file => /\.tar$/i.test(file.name) || file.type === 'application/x-tar')
      .map(file => ({ name: file.name, file }));
    if (items.length) importRecordings(items);
    else if (files.length) toast(t('wrongType'), true);
  }

  function renderSidebar() {
    const search = $('searchInput').value.toLocaleLowerCase().trim();
    const list = $('recordings');
    $('recordingCount').textContent = state.sessions.length;
    $('searchInput').disabled = !state.sessions.length;
    list.replaceChildren();
    for (const session of state.sessions) {
      if (!workspace.accepts(session)) continue;
      if (!(session.title + ' ' + session.source).toLocaleLowerCase().includes(search)) continue;
      const button = document.createElement('button');
      button.className = 'recording';
      if (session === state.session) button.setAttribute('aria-current', 'true');
      button.innerHTML = '<span class="recording-icon">' + icon('archive') +
        '</span><span class="recording-copy"><strong></strong><small></small></span><span class="recording-count count"></span>';
      button.title = session.source;
      button.querySelector('strong').textContent = session.title;
      button.querySelector('small').textContent = session.source;
      const count = button.querySelector('.recording-count');
      const channelCount = session.channels?.length || session.qa?.cameraCount || 0;
      count.textContent = channelCount;
      describe(count, t('channels', { n: channelCount }));
      workspace.addCardState(button, session);
      button.addEventListener('click', () => {
        openEpisode(session);
        if (matchMedia('(max-width: 760px)').matches) setSidebar(false);
      });
      list.append(button);
    }
    if (!list.children.length) {
      const empty = document.createElement('p');
      empty.className = 'sidebar-empty';
      empty.textContent = t(state.sessions.length ? 'noMatches' : 'noSessions');
      list.append(empty);
    }
  }

  function disposeVideo(video) {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
  function releaseSession(session) {
    for (const channel of session.channels) {
      if (channel.video) disposeVideo(channel.video);
      if (channel.rightVideo) disposeVideo(channel.rightVideo);
      if (channel.url) URL.revokeObjectURL(channel.url);
      channel.video = channel.rightVideo = channel.url = null;
    }
    if (session.batchFiles) {
      session.lazy = true;
      session.channels = [];
      session.signals = [];
      session.meta = session.reference = session.alignment = null;
    }
  }

  function registerEpisode(episode) {
    const previous = state.sessions.find(item => item === episode ||
      item.batchPath && item.batchPath === episode.batchPath && item.qa?.key === episode.qa?.key &&
      item.manifest?.size === episode.manifest?.size);
    if (previous) return previous;
    state.sessions.push(episode);
    return episode;
  }

  async function openEpisode(request) {
    if (!request || state.busy) return;
    const episode = request.batchFiles ? registerEpisode(request) : request;
    if (!episode.lazy) { selectSession(episode); return; }
    state.busy = true;
    pause();
    $('loading').hidden = false;
    loadProgress(episode.source, null);
    try {
      const record = await readRecording(episode.batchFiles, episode.source, { scan: false });
      Object.assign(episode, record, {
        lazy: false, qa: episode.qa, qaError: episode.qaError, annotation: episode.annotation, identity: episode.identity,
        time: episode.time ?? 0, loop: episode.loop ?? record.loop, filter: episode.filter ?? record.filter,
        custom: episode.custom ?? record.custom, columns: episode.columns ?? record.columns, split: episode.split ?? record.split,
        chartMode: episode.chartMode ?? record.chartMode, track: episode.track ?? record.track
      });
      if (!state.session && state.view === 'cameras') state.view = 'linked';
      selectSession(episode);
    } catch (error) {
      toast(t('importFailed', { name: episode.source, reason: error.message }), true);
      renderSidebar();
    } finally {
      state.busy = false;
      $('loading').hidden = true;
    }
  }
  function selectSession(session, initialPlay = false) {
    if (session === state.session) return;
    pause();
    closeFocus();
    workspace.release();
    if (state.session) {
      state.session.time = state.time;
      releaseSession(state.session);
    }
    clearLegacyAnalysis();
    state.session = session;
    state.autoStart = initialPlay;
    state.time = session?.time || 0;
    state.duration = 0;
    state.tiles = [];
    $('cameraGrid').replaceChildren();
    $('welcome').hidden = !!session;
    $('session').hidden = $('player').hidden = !session;
    updateCustomPanel(false);
    renderSidebar();
    if (!session) { workspace.emit('closed'); return; }

    $('sessionSource').textContent = session.source;
    $('episodeTitle').textContent = session.title;
    $('episodeId').textContent = typeof session.meta?.episode_id === 'string' && session.meta.episode_id !== session.title
      ? session.meta.episode_id : '';
    $('episodeId').hidden = !$('episodeId').textContent;
    $('columnSelect').value = session.columns;
    $('metadataPanel').open = false;
    for (const channel of session.channels) {
      channel.url = URL.createObjectURL(channel.blob);
      channel.video = createVideo(channel, true);
    }
    updateDuration();
    setView(initialPlay ? (session.manifest ? 'linked' : 'cameras') : state.view);
    renderChecks();
    renderCards();
    seek(state.time);
    workspace.activate(session);
    if (initialPlay && state.duration) {
      state.autoStart = false;
      play();
    }
  }

  function setView(view) {
    state.view = view;
    const linked = view === 'linked';
    $('session').classList.toggle('session-linked', linked);
    $('mediaWorkspace').hidden = view === 'analysis';
    $('mediaWorkspace').classList.toggle('is-linked', linked);
    $('linkedHandle').hidden = $('linkedPane').hidden = !linked;
    $('layoutSelect').value = currentLayout();
    $('analysisView').hidden = view !== 'analysis';
    all('[data-view]').forEach(button => setPressed(button, button.dataset.view === view));
    $('mainScroll').scrollTop = 0;
    if (view === 'analysis' && state.session) {
      state.tiles.forEach(({ video }) => video.pause());
      renderAnalysis();
    }
    $('app').classList.toggle('one-screen', view === 'cameras' && prefs.layout === 'single');
    updateGrid();
    updateSound();
    syncMedia(true);
    workspace.emit('view', view);
  }

  function setPressed(button, active) {
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }

  function renderChecks() {
    const session = state.session;
    $('channelChecks').replaceChildren(...session.channels.map(channel => {
      const option = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = channel.key;
      input.checked = session.custom.has(channel.key);
      option.append(input, document.createTextNode(label(channel)));
      return option;
    }));
  }

  function updateCustomPanel(open) {
    $('customPanel').hidden = !open;
    $('customChip').setAttribute('aria-expanded', String(open));
    if (open && state.session) {
      $('columnSelect').value = state.session.columns;
      renderChecks();
    }
  }

  function visibleChannels() {
    const session = state.session;
    return session.channels.filter(channel => session.filter === 'all' || session.filter === channel.group ||
      (session.filter === 'custom' && session.custom.has(channel.key)));
  }

  function createVideo(channel, primary = false) {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.disablePictureInPicture = true;
    video.setAttribute('aria-hidden', 'true');
    video.addEventListener('loadedmetadata', () => {
      if (!state.session?.channels.includes(channel)) return;
      if (primary && channel.video === video) {
        channel.width = video.videoWidth;
        channel.height = video.videoHeight;
        if (Number.isFinite(video.duration) && video.duration > 0) channel.duration = video.duration;
        updateDuration();
        updateStereo();
        if (state.view === 'analysis') renderQuality();
        if (state.autoStart && state.duration) {
          state.autoStart = false;
          play();
        }
      }
      for (const tile of state.tiles.filter(tile => tile.channel === channel)) updateCardMetadata(tile);
      if (state.focus?.video === video) updateFocusSize();
      if (activeMedia().some(tile => tile.video === video)) syncMedia(true);
    });
    video.addEventListener('error', () => {
      if (video.getAttribute('src')) syncMedia();
    });
    video.src = channel.url;
    return video;
  }

  function updateStereo() {
    const stereo = state.session.channels.some(channel => isOverview(channel) && isStereo(channel));
    const button = $('splitBtn');
    button.disabled = !stereo;
    const split = state.session.split && stereo;
    button.textContent = t(split ? 'merge' : 'split');
    setPressed(button, split);
    describe(button, t(stereo ? (split ? 'merge' : 'split') : 'splitUnavailable'));
  }

  function updateCardMetadata(tile) {
    const { channel, eye, wrap, res, timing } = tile;
    if (eye) {
      wrap.style.setProperty('--aspect', (channel.width / 2 || 16) + ' / ' + (channel.height || 9));
      wrap.style.setProperty('--ratio', channel.width / 2 / channel.height || 16 / 9);
    }
    else wrap.style.setProperty('--aspect', channel.width ? channel.width + ' / ' + channel.height : isOverview(channel) ? '32 / 9' : '16 / 9');
    res.textContent = channel.width && eye ? channel.width / 2 + ' × ' + channel.height : resolution(channel);
    const values = [
      channel.hz ? number(channel.hz) + ' Hz' : null,
      channel.timing?.valid ? number(channel.timing.valid, 0) + (prefs.lang === 'zh' ? ' 帧' : ' stamps') : null,
      channel.offset != null ? 'Δ ' + ms(channel.offset * 1000) : t('noTimestamp')
    ].filter(Boolean);
    timing.textContent = values.join(' · ');
  }

  function makeCard(channel, eye) {
    const name = label(channel) + (eye ? ' · ' + t(eye === 'left' ? 'eyeLeft' : 'eyeRight') : '');
    const card = document.createElement('article');
    const role = isOverview(channel) ? eye ? 'eye-card' : 'overview' : channel.group === 'main' ? 'main-camera' : 'tactile-camera';
    card.className = 'camera-card ' + role;
    if (eye) card.dataset.eye = eye;
    card.innerHTML = '<div class="camera-head"><span class="camera-dot"></span><h3></h3><span class="camera-res"></span>' +
      '<button class="icon-btn expand">' + icon('expand') + '</button></div><div class="media-frame">' +
      '<div class="video-slot"></div><div class="media-status" hidden></div></div><div class="camera-foot"></div>';
    card.querySelector('h3').textContent = name;
    card.querySelector('h3').title = name;
    const button = card.querySelector('button');
    describe(button, t('focus', { name }));
    button.addEventListener('click', () => openFocus(channel, eye));
    const wrap = card.querySelector('.media-frame');
    if (eye) wrap.classList.add('eye', 'eye-' + eye);
    wrap.addEventListener('dblclick', () => openFocus(channel, eye));
    if (eye === 'right' && !channel.rightVideo) channel.rightVideo = createVideo(channel);
    const video = eye === 'right' ? channel.rightVideo : channel.video;
    card.querySelector('.video-slot').append(video);
    const tile = {
      card, channel, eye, video, wrap, res: card.querySelector('.camera-res'),
      timing: card.querySelector('.camera-foot'), status: card.querySelector('.media-status')
    };
    updateCardMetadata(tile);
    return tile;
  }

  function renderCards() {
    if (!state.session) return;
    const session = state.session;
    const channels = visibleChannels();
    const grid = $('cameraGrid');
    const tiles = channels.flatMap(channel => session.split && isOverview(channel) && isStereo(channel)
      ? [makeCard(channel, 'left'), makeCard(channel, 'right')] : [makeCard(channel, null)]);
    const active = new Set(tiles.map(tile => tile.video));
    for (const tile of state.tiles) {
      if (!active.has(tile.video)) tile.video.pause();
    }
    state.tiles = tiles;
    grid.replaceChildren(...tiles.map(tile => tile.card));
    if (!tiles.length) {
      const empty = document.createElement('div');
      empty.className = 'panel empty-cameras';
      empty.textContent = t('noVisible');
      grid.append(empty);
    }
    $('chipAllCount').textContent = session.channels.length;
    const main = session.channels.filter(channel => channel.group === 'main').length;
    $('chipMainCount').textContent = main;
    $('chipTactileCount').textContent = session.channels.length - main;
    all('[data-filter]').forEach(button => setPressed(button, button.dataset.filter === session.filter));
    $('customChip').classList.toggle('active', session.filter === 'custom');
    updateStereo();
    updateGrid();
    updateSound();
    syncMedia(true);
    workspace.emit('tiles', tiles);
  }

  function updateGrid() {
    if (!state.session || state.view === 'analysis') return;
    const grid = $('cameraGrid');
    const width = grid.clientWidth;
    const layout = currentLayout();
    const rows = state.tiles.filter(tile => !isOverview(tile.channel));
    const overviewCount = state.tiles.length - rows.length;
    const singleWide = state.view === 'linked' ? 610 : 790;
    const available = width >= 1160 ? 4 : width >= 620 ? 2 : 1;
    const requested = state.session.filter === 'custom' ? state.session.columns : 0;
    const cols = layout === 'single' ? Math.max(1, Math.min(rows.length, width >= singleWide ? 8 : width >= 500 ? 4 : 2))
      : requested && width >= 620 ? requested : layout === 'compact' && width >= 900 ? 4 : available;
    grid.dataset.layout = layout;
    const oneOverview = overviewCount === 1 || overviewCount === 2 && state.tiles.filter(tile => tile.eye).length === 2;
    const sideBySide = state.view === 'linked' && layout === 'single' && width >= singleWide &&
      oneOverview && rows.length >= 3 && rows.length <= 8;
    grid.classList.toggle('linked-mosaic', sideBySide);
    if (sideBySide) grid.style.setProperty('--linked-camera-columns', Math.ceil(rows.length / 2));
    grid.style.setProperty('--grid-tracks', cols * 2);
    grid.style.setProperty('--eye-span', cols);
    grid.style.setProperty('--wrist-span', layout === 'clear' && cols >= 4 ? 4 : 2);
    $('app').classList.toggle('one-screen', state.view === 'cameras' && layout === 'single');
    grid.style.removeProperty('--media-limit');
    grid.style.removeProperty('--hero-media-limit');
    if (layout === 'single' && width >= singleWide && state.tiles.length) {
      const scroll = state.view === 'linked' ? $('cameraView') : $('mainScroll');
      const availableHeight = scroll.getBoundingClientRect().bottom - grid.getBoundingClientRect().top - scroll.scrollTop - 8;
      const full = state.tiles.filter(tile => isOverview(tile.channel) && !tile.eye).length;
      const eyeRows = Math.ceil(state.tiles.filter(tile => tile.eye).length / 2);
      const rowCount = sideBySide ? 2 : full + eyeRows + Math.ceil(rows.length / cols);
      const minimumMedia = state.view === 'linked' ? 32 : 56;
      grid.style.setProperty('--media-limit', Math.max(minimumMedia, Math.floor((availableHeight - rowCount * 39) / rowCount)) + 'px');
      if (sideBySide) grid.style.setProperty('--hero-media-limit', Math.max(minimumMedia, availableHeight - 33) + 'px');
    }
  }
  function estimateDuration(channel) {
    if (channel.duration) return channel.duration;
    if (channel.frames && channel.hz) return channel.frames / channel.hz;
    const timing = channel.timing;
    return timing?.first != null && timing.expected ? (timing.end - timing.first + timing.expected) / 1000 : 0;
  }

  function updateDuration() {
    const session = state.session;
    const hinted = A.positive(session.meta?.duration_s ?? session.meta?.duration_seconds ?? session.meta?.duration) || 0;
    const mediaDuration = Math.max(0, ...session.channels.map(channel => {
      const local = estimateDuration(channel);
      return local ? offset(channel) + local : 0;
    }));
    state.duration = Math.max(hinted, mediaDuration, session.qa?.duration || 0);
    if (session.loop.a !== null && session.loop.a > state.duration) session.loop.a = session.loop.b = null;
    else if (session.loop.b !== null && session.loop.b > state.duration) session.loop.b = null;
    if (state.time > state.duration) seek(state.duration);
    $('totTime').textContent = timeText(state.duration);
    $('seek').max = state.duration || 1;
    renderTransport();
    renderLoop();
    if (state.view === 'analysis') {
      $('metricDuration').textContent = state.duration ? timeText(state.duration) : '—';
      requestChart();
    }
    workspace.emit('duration', state.duration);
  }

  function activeMedia() {
    const cards = state.view !== 'analysis' ? state.tiles : [];
    return state.focus ? [...cards, state.focus] : cards;
  }

  function updateSound() {
    const active = activeMedia();
    const audible = state.audio ? state.focus || active.find(tile => isOverview(tile.channel)) || active[0] : null;
    for (const tile of state.tiles) tile.video.muted = audible?.video !== tile.video;
    if (state.focus) state.focus.video.muted = audible?.video !== state.focus.video;
    setPressed($('primaryAudio'), state.audio);
  }

  function localTime(channel, time, exactFrame) {
    if (exactFrame != null && workspace.dataset) {
      const key = window.RobotManifest.cameraKey(workspace.dataset, channel.key);
      const pts = key && workspace.dataset.camPtsSec[key][exactFrame];
      if (Number.isFinite(pts)) return pts - workspace.dataset.camPtsOrigin[key];
    }
    return time - offset(channel);
  }

  function syncMedia(force = false) {
    if (!state.session) return;
    for (const { channel, video, status, wrap } of activeMedia()) {
      const local = localTime(channel, state.time, force && !state.playing ? workspace.frameOverride : null);
      const duration = Number.isFinite(video.duration) ? video.duration : channel.duration;
      const waiting = local < -0.001;
      const finished = duration > 0 && local >= duration;
      const error = !!video.error;
      const statusKey = error ? 'videoError' : waiting ? 'beforeStart' : finished ? 'afterEnd'
        : video.readyState < 1 ? 'preparing' : '';
      if (status.dataset.key !== statusKey) {
        status.dataset.key = statusKey;
        status.hidden = !statusKey;
        status.textContent = statusKey ? t(statusKey) : '';
        wrap.classList.toggle('unavailable', error || waiting);
      }
      if (!error && video.readyState >= 1) {
        const target = clamp(local, 0, duration > 0 ? Math.max(0, duration - 0.001) : Math.max(0, local));
        if ((force || !video.seeking) && Math.abs(video.currentTime - target) > (force ? 0.001 : 0.18)) {
          video.currentTime = target;
        }
      }
      if (!state.playing || waiting || finished || error) {
        if (!video.paused) video.pause();
      } else if (video.paused && !video._blocked && !video._starting) {
        video.playbackRate = rate();
        video._starting = true;
        video.play().catch(error => {
          if (error.name !== 'NotAllowedError' || !state.playing) return;
          video._blocked = true;
          const media = activeMedia();
          if (media.every(({ video }) => video._blocked || video.error)) {
            pause();
            toast(t('videoBlocked'), true);
          }
        }).finally(() => { video._starting = false; });
      }
    }
  }

  function currentTime() {
    if (!state.playing) return state.time;
    return clamp(state.anchorTime + (performance.now() - state.anchorAt) * rate() / 1000, 0, state.duration);
  }

  function clockAt(time) {
    state.time = time;
    state.anchorTime = time;
    state.anchorAt = performance.now();
  }

  function seek(time, manifestIndex = null) {
    clockAt(clamp(Number(time) || 0, 0, state.duration));
    workspace.publish(true, manifestIndex);
    syncMedia(true);
    renderTransport();
  }

  function play() {
    if (!state.session || !state.duration || state.playing) return;
    const { a, b, enabled } = state.session.loop;
    if (enabled && a !== null && b !== null && (state.time < a || state.time >= b)) clockAt(a);
    else if (state.time >= state.duration - 0.001) clockAt(0);
    else clockAt(state.time);
    state.playing = true;
    activeMedia().forEach(({ video }) => { video._blocked = false; });
    syncMedia(true);
    workspace.publish(true);
    renderTransport();
    state.lastSync = state.lastUpdate = 0;
    state.raf = requestAnimationFrame(tick);
  }

  function pause() {
    if (state.playing) state.time = currentTime();
    state.playing = false;
    cancelAnimationFrame(state.raf);
    activeMedia().forEach(({ video }) => video.pause());
    workspace.publish(true);
    renderTransport();
  }

  function tick(now) {
    if (!state.playing) return;
    state.time = currentTime();
    const { a, b, enabled } = state.session.loop;
    if (enabled && a !== null && b !== null && state.time >= b) {
      seek(a);
    } else if (state.time >= state.duration) {
      pause();
      seek(state.duration);
      return;
    }
    if (now - state.lastSync > 145) {
      state.lastSync = now;
      syncMedia();
    }
    workspace.publish();
    if (now - state.lastUpdate > 45) {
      state.lastUpdate = now;
      renderTransport();
    }
    state.raf = requestAnimationFrame(tick);
  }

  function renderTransport() {
    const session = state.session;
    const enabled = !!session && state.duration > 0;
    for (const id of ['playBtn', 'focusPlay', 'prevBtn', 'nextBtn', 'frameBackBtn', 'frameFwdBtn', 'loopA', 'loopB', 'seek']) {
      $(id).disabled = !enabled;
    }
    const action = state.playing ? 'pause' : 'play';
    for (const id of ['playBtn', 'focusPlay']) {
      const button = $(id);
      if (button.dataset.action !== action) {
        button.dataset.action = action;
        button.innerHTML = icon(action);
      }
      describe(button, t(action));
    }
    $('curTime').textContent = timeText(state.time);
    $('seek').value = state.time;
    $('seek').style.setProperty('--elapsed', (state.duration ? state.time / state.duration * 100 : 0) + '%');
    $('seek').setAttribute('aria-valuetext', timeText(state.time));
    if (!session) return;
    const reference = session.reference;
    const dt = state.time - offset(reference);
    const total = Math.round(reference.frames || (estimateDuration(reference) || state.duration) * fps());
    const index = dt < 0 || !total ? 0 : Math.min(total, Math.floor(dt * fps() + 1e-6) + 1);
    const data = workspace.dataset;
    const position = data ? workspace.clock.current.index : -1;
    $('frameLabel').textContent = t('frameLabel', {
      now: number(data ? position + 1 : index, 0), total: number(data?.timeSec.length ?? total, 0)
    });
    $('frameLabel').title = data ? 'frame_index: ' + data.frameIndex[position] : t('frameHint', { fps: number(fps()), name: label(reference) });
    if (state.focus) $('focusTime').textContent = timeText(state.time) + ' / ' + timeText(state.duration);
    if (state.view === 'analysis') requestChart();
  }

  function stepFrame(direction) {
    if (!state.session) return;
    if (workspace.dataset) {
      const frame = workspace.clock.current.index;
      workspace.seekFrame(clamp(frame + direction, 0, workspace.dataset.timeSec.length - 1));
      return;
    }
    pause();
    const start = offset(state.session.reference);
    const frame = Math.floor((state.time - start) * fps() + 1e-6) + direction;
    seek(start + frame / fps());
  }

  function togglePlay() {
    if (state.playing) pause();
    else play();
  }

  function renderLoop() {
    const { a, b, enabled } = state.session?.loop || { a: null, b: null, enabled: false };
    setPressed($('loopA'), a !== null);
    setPressed($('loopB'), b !== null);
    describe($('loopA'), t('setLoopA') + (a === null ? '' : ' · ' + timeText(a, 2)));
    describe($('loopB'), t('setLoopB') + (b === null ? '' : ' · ' + timeText(b, 2)));
    $('loopClear').disabled = a === null && b === null;
    $('loopToggle').disabled = a === null || b === null;
    setPressed($('loopToggle'), !!enabled && a !== null && b !== null);
    $('loopRange').hidden = a === null || b === null || !state.duration;
    if (!$('loopRange').hidden) {
      $('loopRange').classList.toggle('loop-disabled', !enabled);
      $('loopRange').style.left = (a / state.duration * 100) + '%';
      $('loopRange').style.width = ((b - a) / state.duration * 100) + '%';
    }
  }

  function markLoop(key) {
    if (!state.session || !state.duration) return;
    const loop = state.session.loop;
    const time = currentTime();
    if (key === 'a') {
      loop.a = time;
      if (loop.b !== null && loop.b - time < 1 / fps()) { loop.b = null; loop.enabled = false; }
    } else {
      if (time - (loop.a ?? 0) < 1 / fps()) return toast(t('invalidLoop'), true);
      loop.a ??= 0;
      loop.b = time;
      loop.enabled = true;
    }
    renderLoop();
    toast(t('loopSet', { marker: key.toUpperCase(), time: timeText(time, 2) }));
  }

  function toggleLoop() {
    const loop = state.session?.loop;
    if (!loop || loop.a === null || loop.b === null) { toast(t('qaSetLoopFirst')); return; }
    loop.enabled = !loop.enabled;
    renderLoop();
  }

  async function fullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch { toast(t('fullscreenUnavailable'), true); }
  }

  function openFocus(channel, eye) {
    if (!channel || $('focusDialog').open) return;
    const video = createVideo(channel);
    const media = document.createElement('div');
    media.className = 'focus-media' + (eye ? ' eye eye-' + eye : '');
    const status = document.createElement('div');
    status.className = 'media-status';
    status.hidden = true;
    media.append(video);
    $('focusStage').replaceChildren(media, status);
    state.focus = { channel, eye, video, media, status, wrap: $('focusStage'), zoom: 'fit', tx: 0, ty: 0, pan: null };
    $('focusName').textContent = label(channel) + (eye ? ' · ' + t(eye === 'left' ? 'eyeLeft' : 'eyeRight') : '');
    all('#focusZoom button').forEach(button => setPressed(button, button.dataset.zoom === 'fit'));
    $('focusDialog').showModal();
    updateSound();
    workspace.emit('focus', state.focus);
    $('focusClose').focus();
    updateFocusSize();
    renderTransport();
    syncMedia(true);
  }

  function closeFocus() {
    if (state.focus) {
      disposeVideo(state.focus.video);
      state.focus = null;
      updateSound();
      workspace.emit('focus', null);
      $('focusStage').replaceChildren();
      $('focusStage').classList.remove('unavailable', 'dragging');
    }
    if ($('focusDialog').open) $('focusDialog').close();
  }

  function updateFocusSize() {
    const focus = state.focus;
    if (!focus) return;
    const width = (focus.video.videoWidth || focus.channel.width || 1920) / (focus.eye ? 2 : 1);
    const height = focus.video.videoHeight || focus.channel.height || 1080;
    const stage = $('focusStage');
    const scale = focus.zoom === 'fit' ? Math.min(stage.clientWidth / width, stage.clientHeight / height) : Number(focus.zoom);
    const overflowX = Math.max(0, (width * scale - stage.clientWidth) / 2);
    const overflowY = Math.max(0, (height * scale - stage.clientHeight) / 2);
    focus.tx = clamp(focus.tx, -overflowX, overflowX);
    focus.ty = clamp(focus.ty, -overflowY, overflowY);
    focus.media.style.width = width * scale + 'px';
    focus.media.style.height = height * scale + 'px';
    focus.media.style.transform = 'translate(-50%, -50%) translate(' + focus.tx + 'px, ' + focus.ty + 'px)';
    $('focusRes').textContent = width + ' × ' + height;
  }
  let plotModel = null;
  let plotScene = null;
  function clearLegacyAnalysis() {
    if (state.chartRaf) cancelAnimationFrame(state.chartRaf);
    state.chartRaf = 0;
    plotModel = plotScene = null;
    const canvas = $('plotCanvas');
    canvas.width = canvas.height = 0;
    $('qualityRows').replaceChildren();
    $('trackSelect').replaceChildren();
    $('metadataText').textContent = '';
    $('plotTooltip').hidden = true;
  }
  const preferredTiming = channel => channel.rawTiming?.points.length ? channel.rawTiming : channel.timing;
  const intervalTracks = session => session.channels.flatMap(channel => [
    { channel, stamps: channel.rawTiming, raw: true },
    { channel, stamps: channel.timing, raw: false }
  ].filter(track => track.stamps?.points.length));

  function renderAnalysis() {
    const session = state.session;
    if (!session) return;
    const offsets = session.channels.map(channel => channel.offset).filter(value => value !== null);
    const gaps = session.channels.map(channel => preferredTiming(channel)?.gaps).filter(value => value != null);
    $('metricDuration').textContent = state.duration ? timeText(state.duration) : '—';
    $('metricCoverage').textContent = session.alignment.measured + ' / ' + session.channels.length;
    $('metricSpread').textContent = offsets.length > 1 ? ms(Math.max(...offsets) * 1000) : '—';
    $('metricGaps').textContent = gaps.length ? number(gaps.reduce((sum, value) => sum + value, 0), 0) : '—';

    const note = $('analysisNote');
    const messages = [t(session.alignment.origin === null ? 'noAlignment' : prefs.sync === 'capture'
      ? session.alignment.clock === 'session' ? 'sessionAlignment' : 'captureAlignment' : 'videoAlignment')];
    if (prefs.sync === 'capture' && offsets.length && offsets.length < session.channels.length) {
      messages.push(t('partialAlignment', { n: session.channels.length - offsets.length }));
    }
    const legacy = session.channels.filter(channel => channel.timing?.legacyMs || channel.rawTiming?.legacyMs).length;
    if (legacy) messages.push(t('legacyTiming', { n: legacy }));
    if (session.malformed) messages.push(t('malformedData', { n: session.malformed }));
    note.hidden = false;
    note.textContent = messages.join(' ');
    $('metadataPanel').hidden = !session.meta;
    $('metadataText').textContent = session.meta ? JSON.stringify(session.meta, null, 2) : '';
    renderQuality();
    renderTracks();
  }

  function renderQuality() {
    const session = state.session;
    const tracks = intervalTracks(session);
    $('qualityRows').replaceChildren(...session.channels.map(channel => {
      const row = document.createElement('tr');
      const name = document.createElement('th');
      name.scope = 'row';
      const index = tracks.findIndex(track => track.channel === channel);
      if (index >= 0) {
        const button = document.createElement('button');
        button.className = 'table-link';
        button.textContent = label(channel);
        button.addEventListener('click', () => {
          session.chartMode = 'timing';
          session.track.timing = index;
          renderTracks();
          $('trackSelect').focus();
        });
        name.append(button);
      } else {
        name.textContent = label(channel);
      }
      const timing = preferredTiming(channel);
      const flags = channel.timing?.flags;
      const cells = [
        resolution(channel), timing?.first != null ? t(timing === channel.rawTiming ? 'rawTiming' : 'encodedTiming') : '—',
        ms(channel.offset === null ? null : channel.offset * 1000),
        number(timing?.valid, 0), timing?.hz ? number(timing.hz) + ' Hz' : '—',
        ms(timing?.p95), ms(timing?.max), number(timing?.gaps, 0), number(timing?.duplicates, 0),
        number(timing?.reversed, 0), number(timing?.invalid, 0), number(flags?.synthetic, 0), number(flags?.dropped, 0)
      ];
      row.append(name, ...cells.map((value, index) => {
        const cell = document.createElement('td');
        cell.textContent = value;
        if (index >= 7 && value !== '—' && value !== '0') cell.className = 'attention';
        return cell;
      }));
      return row;
    }));
  }

  function renderTracks() {
    const session = state.session;
    const mode = session.chartMode;
    const timing = mode === 'timing';
    const tracks = timing ? intervalTracks(session) : session.signals;
    all('[data-chart]').forEach(button => setPressed(button, button.dataset.chart === mode));
    const select = $('trackSelect');
    select.replaceChildren(...tracks.map((track, index) => {
      const option = document.createElement('option');
      option.value = index;
      option.textContent = timing ? label(track.channel) + ' · ' + t(track.raw ? 'rawTiming' : 'encodedTiming')
        : track.label + ' · ' + [track.source, track.name.replace(/^.*?\/(?=observation\.)/i, '')].filter(Boolean).join(' / ');
      return option;
    }));
    select.disabled = !tracks.length;
    select.value = session.track[mode];
    const track = tracks[session.track[mode]];
    const canvas = $('plotCanvas');
    $('plotEmpty').hidden = !!track;
    $('plotEmpty').textContent = t(timing ? 'noIntervals' : 'noSignals');
    $('plotTooltip').hidden = true;
    canvas.tabIndex = track ? 0 : -1;
    plotModel = null;
    plotScene = null;
    let detail = '';
    if (track && timing) {
      const { stamps, channel } = track;
      const alignment = session.alignment;
      const origin = stamps.clock === alignment.clock && alignment.origin !== null
        ? alignment.origin + (prefs.sync === 'video' ? (channel.offset ?? 0) * 1000 : 0)
        : stamps.first - offset(channel) * 1000;
      plotModel = {
        kind: 'timing', points: stamps.points.map(([stamp, value]) => [(stamp - origin) / 1000, value]),
        threshold: stamps.expected ? stamps.expected * 1.5 : null
      };
      detail = t('intervalMeta', {
        span: timeText((stamps.end - stamps.first) / 1000, 2),
        expected: ms(stamps.expected), p95: ms(stamps.p95), max: ms(stamps.max)
      });
    } else if (track) {
      const shift = track.channel && prefs.sync === 'video' ? track.channel.offset ?? 0 : 0;
      plotModel = { kind: 'signal', points: shift ? track.points.map(([time, value]) => [time - shift, value]) : track.points };
      detail = t('signalMeta', {
        n: number(track.points.length, 0), min: number(track.min, 5), mean: number(track.mean, 5), max: number(track.max, 5),
        clock: t(track.anchored ? 'signalAnchored' : track.clock === 'frame' ? 'signalFrame' : 'signalRelative')
      });
    }
    $('chartMeta').textContent = detail;
    $('chartMeta').hidden = !detail;
    requestChart();
  }

  function requestChart() {
    if (state.chartRaf || state.view !== 'analysis' || !state.session) return;
    state.chartRaf = requestAnimationFrame(() => {
      state.chartRaf = 0;
      if (state.session && state.view === 'analysis') drawChart();
    });
  }

  function sampleForPlot(points, width, first, last) {
    if (points.length <= width * 2) return points;
    const chosen = [];
    let index = 0;
    for (let pixel = 0; pixel <= width && index < points.length; pixel++) {
      const limit = first + (last - first) * (pixel + 1) / width;
      let minimum = index;
      let maximum = index;
      const start = index;
      while (index < points.length && points[index][0] < limit) {
        if (points[index][1] < points[minimum][1]) minimum = index;
        if (points[index][1] > points[maximum][1]) maximum = index;
        index++;
      }
      if (index > start) {
        chosen.push(points[Math.min(minimum, maximum)]);
        if (minimum !== maximum) chosen.push(points[Math.max(minimum, maximum)]);
      }
    }
    return chosen;
  }

  function drawChart() {
    const canvas = $('plotCanvas');
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!plotModel) return;

    if (!plotScene || plotScene.width !== width || plotScene.height !== height || plotScene.duration !== state.duration) {
      const { points, threshold } = plotModel;
      const first = Math.min(0, points[0][0]);
      const last = Math.max(first + 0.001, state.duration, points.at(-1)[0]);
      let min = plotModel.kind === 'timing' ? 0 : points[0][1];
      let max = threshold ?? min;
      for (const [, value] of points) {
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
      const padding = max > min ? Math.max((max - min) * 0.09, Number.EPSILON * Math.abs(max)) : Math.abs(max) * 0.1 || 1;
      const low = min === 0 && plotModel.kind === 'timing' ? 0 : min - padding;
      const high = max + padding;
      const left = width > 500 ? 78 : 59;
      const right = width - 24;
      const top = 18;
      const bottom = height - 34;
      const x = time => left + (time - first) / (last - first) * Math.max(1, right - left);
      const y = value => bottom - (value - low) / (high - low) * (bottom - top);
      plotScene = {
        width, height, duration: state.duration, low, high, first, last, left, right, top, bottom, x, y,
        samples: sampleForPlot(points, Math.max(1, right - left), first, last)
      };
    }

    const { left, right, top, bottom, x, y, low, high, first, last, samples } = plotScene;
    const style = getComputedStyle(document.documentElement);
    const color = name => style.getPropertyValue('--' + name).trim();
    const line = (x1, y1, x2, y2) => {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    };
    const axisNumber = value => value !== 0 && (Math.abs(value) < 0.001 || Math.abs(value) >= 100000)
      ? value.toExponential(1) : number(value, 3);
    ctx.lineWidth = 1;
    ctx.font = '11px monospace';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color('muted');
    ctx.strokeStyle = color('line');
    ctx.textAlign = 'right';
    for (let step = 0; step <= 4; step++) {
      const value = low + (high - low) * step / 4;
      const pos = y(value);
      line(left, pos, right, pos);
      ctx.fillText(axisNumber(value) + (plotModel.kind === 'timing' ? ' ms' : ''), left - 9, pos);
    }
    ctx.textAlign = 'center';
    const steps = width >= 720 ? 6 : width >= 440 ? 4 : 2;
    for (let step = 0; step <= steps; step++) {
      const value = first + (last - first) * step / steps;
      const pos = x(value);
      line(pos, top, pos, bottom);
      ctx.fillText((value < 0 ? '−' : '') + timeText(Math.abs(value), last - first < 2 ? 2 : 1), pos, bottom + 16);
    }
    if (plotModel.threshold !== null && plotModel.threshold !== undefined) {
      ctx.strokeStyle = color('warning');
      ctx.setLineDash([4, 4]);
      line(left, y(plotModel.threshold), right, y(plotModel.threshold));
      ctx.setLineDash([]);
    }
    ctx.strokeStyle = color('trace');
    ctx.lineWidth = 1.55;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (const [index, [time, value]] of samples.entries()) {
      if (!index) ctx.moveTo(x(time), y(value));
      else ctx.lineTo(x(time), y(value));
    }
    ctx.stroke();
    if (samples.length === 1) {
      ctx.fillStyle = color('trace');
      ctx.beginPath();
      ctx.arc(x(samples[0][0]), y(samples[0][1]), 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = color('accent');
    ctx.lineWidth = 1;
    line(x(state.time), top, x(state.time), bottom);
  }

  function plotPoint(event) {
    if (!plotScene || !plotModel) return null;
    const { left, right, first, last } = plotScene;
    const box = $('plotCanvas').getBoundingClientRect();
    const ratio = clamp((event.clientX - box.left - left) / (right - left), 0, 1);
    return A.nearest(plotModel.points, first + (last - first) * ratio);
  }

  function showPlotPoint(point) {
    const tooltip = $('plotTooltip');
    const [time, value] = point;
    tooltip.textContent = (time < 0 ? '−' : '') + timeText(Math.abs(time), 3) + ' · ' +
      number(value, 6) + (plotModel.kind === 'timing' ? ' ms' : '');
    tooltip.hidden = false;
    tooltip.style.left = clamp(plotScene.x(time), tooltip.offsetWidth / 2 + 5, plotScene.width - tooltip.offsetWidth / 2 - 5) + 'px';
    tooltip.style.top = clamp(plotScene.y(value) - 33, 2, plotScene.height - 30) + 'px';
  }

  function exportQuality() {
    const session = state.session;
    const rows = [[
      'channel', 'width', 'height', 'timestamp_source', 'start_offset_ms', 'valid_rows', 'nominal_hz', 'measured_hz',
      'median_interval_ms', 'p95_interval_ms', 'max_interval_ms', 'expected_interval_ms',
      'long_intervals', 'duplicate_timestamps', 'reversed_timestamps', 'invalid_rows', 'legacy_ns_detected',
      'encoded_captured_rows', 'encoded_synthetic_rows', 'encoded_confirmed_drop_rows', 'encoded_unknown_rows'
    ]];
    for (const channel of session.channels) {
      const timing = preferredTiming(channel);
      const flags = channel.timing?.flags;
      const raw = timing === channel.rawTiming;
      rows.push([
        channel.key, channel.width || null, channel.height || null, timing?.first == null ? null : raw ? 'raw' : 'encoded',
        channel.offset === null ? null : channel.offset * 1000, timing?.valid, raw ? channel.rawHz : channel.hz, timing?.hz,
        timing?.median, timing?.p95, timing?.max, timing?.expected, timing?.gaps,
        timing?.duplicates, timing?.reversed, timing?.invalid, timing ? Number(timing.legacyMs) : null,
        flags?.captured, flags?.synthetic, flags?.dropped, flags?.unknown
      ]);
    }
    const name = session.source.replace(/\.tar$/i, '').replace(/[<>:"/\\|?*]/g, '_') + '-quality.csv';
    workspace.download(new Blob(['\ufeff', A.csvText(rows)], { type: 'text/csv;charset=utf-8' }), name);
    toast(t('exportDone'));
  }
  function setSidebar(open) {
    $('app').classList.toggle('sidebar-closed', !open);
    $('collapseBtn').setAttribute('aria-expanded', String(open));
    $('sidebar').inert = !open;
    updateGrid();
  }

  for (const id of ['openTarBtn', 'welcomeTarBtn']) $(id).addEventListener('click', () => $('tarInput').click());
  for (const id of ['openFolderBtn', 'welcomeFolderBtn']) $(id).addEventListener('click', () => $('folderInput').click());
  $('tarInput').addEventListener('change', event => {
    importTar(event.target.files);
    event.target.value = '';
  });
  function pickFolder(event, batch) {
    const files = [...event.target.files];
    if (files.length) {
      const entries = files.map(file => ({ name: file.webkitRelativePath || file.name, blob: file }));
      const name = entries[0].name.split('/')[0];
      if (!workspace.scanFolder?.(entries, name, batch)) importRecordings([{ name, entries }]);
    }
    event.target.value = '';
  }
  $('folderInput').addEventListener('change', event => pickFolder(event, false));
  $('batchFolderInput').addEventListener('change', event => pickFolder(event, true));
  $('searchInput').addEventListener('input', renderSidebar);
  $('removeSessionBtn').addEventListener('click', () => {
    const index = state.sessions.indexOf(state.session);
    state.sessions.splice(index, 1);
    const next = state.sessions[index] || state.sessions[index - 1];
    if (!next || next.lazy) selectSession(null);
    if (next) openEpisode(next);
  });
  $('collapseBtn').addEventListener('click', () => setSidebar($('app').classList.contains('sidebar-closed')));
  const narrowScreen = matchMedia('(max-width: 760px)');
  narrowScreen.addEventListener('change', event => setSidebar(!event.matches));
  $('langBtn').addEventListener('click', () => {
    prefs.lang = prefs.lang === 'zh' ? 'en' : 'zh';
    save('lang', prefs.lang);
    localize();
  });
  $('themeBtn').addEventListener('click', () => {
    prefs.theme = prefs.theme === 'light' ? 'dark' : 'light';
    save('theme', prefs.theme);
    updateTheme();
    requestChart();
  });

  all('[data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
  all('[data-filter]').forEach(button => button.addEventListener('click', () => {
    state.session.filter = button.dataset.filter;
    updateCustomPanel(false);
    renderCards();
  }));
  $('customChip').addEventListener('click', () => updateCustomPanel($('customPanel').hidden));
  $('selectAllBtn').addEventListener('click', () => all('#channelChecks input').forEach(input => { input.checked = true; }));
  $('noneBtn').addEventListener('click', () => all('#channelChecks input').forEach(input => { input.checked = false; }));
  $('applyCustomBtn').addEventListener('click', () => {
    const session = state.session;
    session.custom = new Set(all('#channelChecks input:checked').map(input => input.value));
    session.columns = Number($('columnSelect').value);
    session.filter = 'custom';
    updateCustomPanel(false);
    renderCards();
    $('customChip').focus();
  });
  $('layoutSelect').addEventListener('change', event => {
    const key = state.view === 'linked' ? 'linkedLayout' : 'layout';
    prefs[key] = event.target.value;
    save(key, prefs[key]);
    updateGrid();
  });
  $('splitBtn').addEventListener('click', () => {
    state.session.split = !state.session.split;
    renderCards();
  });
  $('primaryAudio').addEventListener('click', () => { state.audio = !state.audio; updateSound(); });
  $('syncMode').addEventListener('change', event => {
    const time = currentTime();
    prefs.sync = event.target.value;
    save('sync', prefs.sync);
    updateDuration();
    seek(time);
    if (state.view === 'analysis') renderAnalysis();
  });

  $('playBtn').addEventListener('click', togglePlay);
  $('focusPlay').addEventListener('click', togglePlay);
  $('prevBtn').addEventListener('click', () => seek(currentTime() - 5));
  $('nextBtn').addEventListener('click', () => seek(currentTime() + 5));
  $('frameBackBtn').addEventListener('click', () => stepFrame(-1));
  $('frameFwdBtn').addEventListener('click', () => stepFrame(1));
  $('seek').addEventListener('input', event => seek(event.target.valueAsNumber));
  $('speed').addEventListener('change', () => {
    const time = currentTime();
    state.playbackRate = Number($('speed').value) || 1;
    clockAt(time);
    activeMedia().forEach(({ video }) => { video.playbackRate = rate(); });
  });
  $('loopA').addEventListener('click', () => markLoop('a'));
  $('loopB').addEventListener('click', () => markLoop('b'));
  $('loopToggle').addEventListener('click', toggleLoop);
  $('loopClear').addEventListener('click', () => {
    state.session.loop = { a: null, b: null, enabled: false };
    renderLoop();
  });
  $('fullscreenBtn').addEventListener('click', fullscreen);

  $('focusClose').addEventListener('click', closeFocus);
  $('focusDialog').addEventListener('cancel', event => { event.preventDefault(); closeFocus(); });
  $('focusDialog').addEventListener('click', event => { if (event.target === $('focusDialog')) closeFocus(); });
  $('helpBtn').addEventListener('click', () => $('helpDialog').showModal());
  $('helpClose').addEventListener('click', () => $('helpDialog').close());
  all('#focusZoom button').forEach(button => button.addEventListener('click', () => {
    if (!state.focus) return;
    state.focus.zoom = button.dataset.zoom;
    state.focus.tx = state.focus.ty = 0;
    all('#focusZoom button').forEach(option => setPressed(option, option === button));
    updateFocusSize();
  }));
  const stage = $('focusStage');
  stage.addEventListener('pointerdown', event => {
    const focus = state.focus;
    if (!focus || focus.zoom === 'fit' || event.button !== 0) return;
    focus.pan = { x: event.clientX - focus.tx, y: event.clientY - focus.ty, pointer: event.pointerId };
    stage.setPointerCapture(event.pointerId);
    stage.classList.add('dragging');
  });
  stage.addEventListener('pointermove', event => {
    const focus = state.focus;
    if (focus?.pan?.pointer !== event.pointerId) return;
    focus.tx = event.clientX - focus.pan.x;
    focus.ty = event.clientY - focus.pan.y;
    updateFocusSize();
  });
  stage.addEventListener('lostpointercapture', () => {
    if (state.focus) state.focus.pan = null;
    stage.classList.remove('dragging');
  });
  stage.addEventListener('dblclick', closeFocus);

  all('[data-chart]').forEach(button => button.addEventListener('click', () => {
    state.session.chartMode = button.dataset.chart;
    renderTracks();
  }));
  $('trackSelect').addEventListener('change', event => {
    state.session.track[state.session.chartMode] = Number(event.target.value);
    renderTracks();
  });
  $('exportBtn').addEventListener('click', exportQuality);
  $('plotCanvas').addEventListener('pointermove', event => {
    const point = plotPoint(event);
    if (point) showPlotPoint(point);
  });
  $('plotCanvas').addEventListener('pointerleave', () => { $('plotTooltip').hidden = true; });
  $('plotCanvas').addEventListener('blur', () => { $('plotTooltip').hidden = true; });
  $('plotCanvas').addEventListener('click', event => {
    const point = plotPoint(event);
    if (point) seek(point[0]);
  });
  $('plotCanvas').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    if (!plotModel) return;
    const direction = event.key === 'ArrowLeft' ? -1 : 1;
    const index = direction < 0 ? A.scanBounds(plotModel.points, state.time - 1e-6) - 1
      : A.scanBounds(plotModel.points, state.time + 1e-6);
    const point = plotModel.points[index];
    if (point) {
      pause();
      seek(point[0]);
      if (plotScene) showPlotPoint(point);
    }
  });

  addEventListener('keydown', event => {
    const target = event.target;
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey ||
        target?.matches?.('input, select, textarea') || target?.isContentEditable || state.busy) return;
    if (event.key === '?' && !$('helpDialog').open && !$('focusDialog').open) {
      $('helpDialog').showModal();
      return;
    }
    if (!state.session || $('helpDialog').open) return;
    if (document.querySelector('dialog[open]:not(#focusDialog)')) return;
    if (!$('focusDialog').open && workspace.handleKey?.(event)) return;
    if (event.key === ' ' && !target?.closest?.('button, a, summary')) {
      event.preventDefault();
      togglePlay();
    } else if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      stepFrame((event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 10 : 1));
    } else if (event.key === ',' || event.key === '.') {
      stepFrame(event.key === ',' ? -1 : 1);
    } else if (event.key.toLowerCase() === 'f') {
      fullscreen();
    } else if (/^[1-7]$/.test(event.key)) {
      const slot = Number(event.key) - 1;
      const channel = state.session.channels.find(channel => channel.key === order[slot]) || state.session.channels[slot];
      openFocus(channel);
    }
  });

  const draggingFiles = event => event.dataTransfer && [...event.dataTransfer.types].includes('Files');
  addEventListener('dragenter', event => {
    if (!draggingFiles(event)) return;
    event.preventDefault();
    if (!state.busy) {
      state.dragDepth++;
      $('dropOverlay').hidden = false;
    }
  });
  addEventListener('dragover', event => {
    if (draggingFiles(event)) event.preventDefault();
  });
  addEventListener('dragleave', event => {
    if (!draggingFiles(event)) return;
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (!state.dragDepth) $('dropOverlay').hidden = true;
  });
  addEventListener('drop', event => {
    if (!draggingFiles(event)) return;
    event.preventDefault();
    state.dragDepth = 0;
    $('dropOverlay').hidden = true;
    if (!state.busy) importTar(event.dataTransfer.files);
  });

  const resize = new ResizeObserver(() => {
    updateGrid();
    updateFocusSize();
    requestChart();
  });
  resize.observe($('mainScroll'));
  resize.observe($('plot'));
  resize.observe(stage);
  const workspace = window.RobotWorkspace.create({
    t, describe, setPressed, label, timeText, number, toast, seek, pause, markLoop, toggleLoop,
    time: () => state.time, playing: () => state.playing, lang: () => prefs.lang, view: () => state.view,
    duration: () => state.duration, updateGrid, localTime,
    sessions: () => state.sessions, refreshSidebar: renderSidebar, refreshDuration: updateDuration, registerEpisode, openEpisode,
    tiles: () => state.tiles, session: () => state.session
  });
  addEventListener('pagehide', event => {
    if (!event.persisted && state.session) {
      closeFocus();
      releaseSession(state.session);
    }
  });
  setSidebar(!narrowScreen.matches);
  $('layoutSelect').value = prefs.layout;
  $('syncMode').value = prefs.sync;
  updateTheme();
  localize();
})();
