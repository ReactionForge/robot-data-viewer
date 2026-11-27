/* Batch folder QA scans manifests first and opens media only for a selected episode. */
(function (global) {
  'use strict';
  const $ = id => document.getElementById(id);
  const M = global.RobotManifest;
  const rootManifest = '/global_frame_manifest.jsonl';
  const metaManifest = '/meta/global_frame_manifest.jsonl';
  Object.assign(global.ViewerStrings, {
    qaBatchFolder: ['扫描文件夹', 'Scan folder'], qaBatchCancel: ['停止扫描', 'Stop scan'],
    qaBatchGrade: ['自动分级', 'Automatic grade'], qaBatchAllGrades: ['全部分级', 'All grades'],
    qaBatchAllLabels: ['全部标签', 'All labels'], qaBatchExportList: ['导出会话 JSON', 'Export episode JSON'],
    qaBatchEpisode: ['会话', 'Episode'], qaBatchNote: ['备注', 'Note'],
    qaBatchEmpty: ['选择包含各会话帧清单的目录，可直接打开任一质检结果。', 'Choose an episode folder containing frame manifests. Open a recording from any QA row.'],
    qaBatchNoMatches: ['没有符合当前筛选的会话。', 'No episodes match the filters.'],
    qaBatchRate: ['{name} · 自动合格率 {rate} · {pass}/{total} 段', '{name} · Automatic pass rate {rate} · {pass}/{total} episodes'],
    qaBatchIssues: ['主要异常', 'Top issues'],
    qaBatchScanning: ['扫描中 {done} / {total}', 'Scanning {done} / {total}'],
    qaBatchStopped: ['已停止，保留扫描结果。', 'Scan stopped. Completed results are kept.'],
    qaBatchMissing: ['目录中未找到帧清单。', 'No frame manifests found in this folder.'],
    qaBatchOpenEpisode: ['打开 {name}', 'Open {name}']
  });

  /** @param {{name: string, blob: Blob}[]} entries */
  function groupFolder(entries) {
    const groups = new Map();
    const normalized = entries.map(entry => ({ ...entry, name: entry.name.replace(/\\/g, '/') }));
    for (const entry of normalized) {
      const lower = '/' + entry.name.toLowerCase().replace(/^\/+/, '');
      const inMeta = lower.endsWith(metaManifest);
      if (!inMeta && !lower.endsWith(rootManifest)) continue;
      const suffix = inMeta ? metaManifest : rootManifest;
      const prefix = entry.name.slice(0, Math.max(0, entry.name.length - suffix.length));
      if (!groups.has(prefix) || inMeta) groups.set(prefix, { manifest: entry.blob, files: [], prefix });
    }
    if (!groups.size) return [];
    for (const entry of normalized) {
      let slash = entry.name.lastIndexOf('/');
      for (;;) {
        const prefix = slash >= 0 ? entry.name.slice(0, slash) : '';
        const group = groups.get(prefix);
        if (group) { group.files.push(entry); break; }
        if (slash < 0) break;
        slash = entry.name.lastIndexOf('/', slash - 1);
      }
    }
    return [...groups.values()].sort((a, b) => a.prefix.localeCompare(b.prefix));
  }

  function annotations(fallback) {
    let connection;
    function open() {
      if (connection) return connection;
      connection = new Promise(resolve => {
        let request;
        try { request = indexedDB.open('robot-data-viewer-qa', 1); }
        catch { resolve(null); return; }
        let settled = false;
        const timer = setTimeout(() => finish(null), 1500);
        function finish(db) {
          if (settled) { db?.close(); return; }
          settled = true;
          clearTimeout(timer);
          resolve(db);
        }
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains('annotations')) request.result.createObjectStore('annotations');
        };
        request.onerror = request.onblocked = () => finish(null);
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => { db.close(); connection = null; };
          finish(db);
        };
      });
      return connection;
    }
    async function transaction(mode, use) {
      const db = await open();
      if (!db) throw new Error('IndexedDB unavailable');
      return new Promise((resolve, reject) => {
        try {
          const tx = db.transaction('annotations', mode);
          const request = use(tx.objectStore('annotations'));
          tx.oncomplete = () => resolve(request.result);
          tx.onabort = tx.onerror = () => reject(tx.error || new Error('Annotation transaction failed'));
        } catch (error) { reject(error); }
      });
    }
    addEventListener('pagehide', event => {
      if (!event.persisted) connection?.then(db => db?.close());
    });
    return {
      async get(episode) {
        const key = M.annotationKey(episode);
        try { return await transaction('readonly', store => store.get(key)) || await fallback.get(episode); }
        catch { return fallback.get(episode); }
      },
      async set(episode, record) {
        const key = M.annotationKey(episode);
        try { await transaction('readwrite', store => store.put(record, key)); }
        catch { await fallback.set(episode, record); }
      }
    };
  }

  global.RobotWorkspace.use(w => {
    const api = w.api;
    const t = api.t;
    const dialog = $('qaBatchDialog');
    let results = [];
    let rootName = '';
    let job = null;
    let scanned = 0;
    let total = 0;
    let stopped = false;
    let sortKey = 'grade';
    let descending = true;
    let editingNote = false;
    w.annotationStore = annotations(w.annotationStore);

    const grade = episode => episode.qaError ? 'ERROR' : episode.qa?.grade || '';
    const order = { ERROR: 4, FAIL: 3, WARN: 2, PASS: 1 };
    const qa = (episode, field) => episode.qa?.[field] ?? null;
    const count = (episode, field) => episode.qa?.count[field] ?? null;
    const coverage = (episode, side) => episode.qa ? episode.qa.count[side === 'left' ? 'poseLeft' : 'poseRight'] / episode.qa.frames : null;
    const columns = [
      ['title', 'qaBatchEpisode', episode => episode.title],
      ['grade', 'qaBatchGrade', episode => order[grade(episode)] ?? null],
      ['mark', 'qaMark', episode => episode.annotation?.mark || ''],
      ['frames', 'qaFrames', episode => qa(episode, 'frames')],
      ['duration', 'duration', episode => qa(episode, 'duration')],
      ['max', 'qaSync', episode => qa(episode, 'maxSpanMs')],
      ['rate', '≤10 ms', episode => qa(episode, 'within10Rate')],
      ['synthetic', 'qaSynthetic', episode => count(episode, 'synthetic')],
      ['jumps', 'qaSequence', episode => count(episode, 'jumps')],
      ['pose', 'qaPose', episode => episode.qa ? (coverage(episode, 'left') + coverage(episode, 'right')) / 2 : null],
      ['gaps', 'qaGaps', episode => count(episode, 'sensorGaps')],
      ['note', 'qaBatchNote', episode => episode.annotation?.note || '']
    ];

    function show() {
      if (!dialog.open) {
        api.pause();
        dialog.showModal();
      }
      render();
    }

    w.scanFolder = (entries, name, explicit) => {
      const groups = groupFolder(entries);
      if (!explicit && groups.length < 2) return false;
      if (!groups.length) { show(); api.toast(t('qaBatchMissing'), true); return true; }
      run(groups, name);
      return true;
    };

    async function run(groups, name) {
      job?.abort();
      const owner = new AbortController();
      job = owner;
      results = [];
      rootName = name;
      scanned = 0;
      total = groups.length;
      stopped = false;
      $('qaBatchGrade').value = $('qaBatchMark').value = '';
      show();
      let previousPaint = 0;
      for (const group of groups) {
        if (owner.signal.aborted) break;
        const source = group.prefix.split('/').at(-1) || name;
        const episode = {
          source, title: source, identity: source, batchPath: group.prefix || name, batchFiles: group.files,
          manifest: group.manifest, fps: 30, lazy: true
        };
        try { await w.scan(episode, owner.signal); }
        catch { if (owner.signal.aborted) break; }
        if (job !== owner || owner.signal.aborted) break;
        results.push(api.registerEpisode(episode));
        scanned++;
        if (performance.now() - previousPaint > 100) {
          previousPaint = performance.now();
          api.refreshSidebar();
          render();
        } else progress();
      }
      if (job !== owner) return;
      stopped = owner.signal.aborted;
      job = null;
      api.refreshSidebar();
      render();
    }

    function filtered() {
      const g = $('qaBatchGrade').value;
      const m = $('qaBatchMark').value;
      const value = columns.find(([key]) => key === sortKey)[2];
      return results.filter(episode => (!g || grade(episode) === g) &&
        (!m || (episode.annotation?.mark || 'unmarked') === m)).sort((a, b) => {
        const x = value(a);
        const y = value(b);
        if (x == null) return y == null ? 0 : 1;
        if (y == null) return -1;
        const comparison = typeof x === 'number' ? x - y : String(x).localeCompare(String(y));
        return (descending ? -comparison : comparison) || a.title.localeCompare(b.title);
      });
    }

    function summary() {
      const target = $('qaBatchSummary');
      target.replaceChildren();
      if (!rootName) return;
      const passed = results.filter(episode => episode.qa?.grade === 'PASS' && !episode.qaError).length;
      const text = document.createElement('strong');
      text.textContent = t('qaBatchRate', { name: rootName, pass: passed, total: results.length,
        rate: w.percent(results.length ? passed / results.length : null) });
      target.append(text);
      const issues = new Map();
      for (const episode of results) {
        for (const [key, n] of episode.qa?.issues || []) issues.set(key, (issues.get(key) || 0) + n);
        if (episode.qaError) issues.set('incomplete', (issues.get('incomplete') || 0) + 1);
      }
      if (issues.size) {
        const content = document.createElement('span');
        content.textContent = t('qaBatchIssues') + ' · ' + [...issues].sort((a, b) => b[1] - a[1]).slice(0, 4)
          .map(([key, n]) => w.issue(key) + ' ' + w.number(n, 0)).join(' · ');
        target.append(content);
      }
    }

    function progress() {
      $('qaBatchProgress').hidden = !job && !stopped;
      $('qaBatchCancelBtn').hidden = !job;
      $('qaBatchProgress').textContent = job ? t('qaBatchScanning', { done: scanned, total }) : stopped ? t('qaBatchStopped') : '';
    }

    function cells(row, values) {
      for (const value of values) {
        const cell = document.createElement('td');
        if (value instanceof HTMLElement) cell.append(value);
        else cell.textContent = value;
        row.append(cell);
      }
    }

    function makeRow(episode) {
      const row = document.createElement('tr');
      const open = document.createElement('button');
      open.className = 'table-link';
      open.textContent = episode.title;
      api.describe(open, t('qaBatchOpenEpisode', { name: episode.title }));
      if (episode.qaError) open.title = episode.qaError;
      function choose() { dialog.close(); api.openEpisode(episode); }
      open.addEventListener('click', choose);
      row.addEventListener('click', event => { if (!event.target.closest('input, button, select')) choose(); });
      const status = document.createElement('span');
      status.className = 'qa-grade';
      status.dataset.grade = grade(episode) === 'ERROR' ? 'FAIL' : grade(episode);
      status.textContent = grade(episode) || '—';
      const mark = document.createElement('select');
      api.describe(mark, t('qaMark') + ' · ' + episode.title);
      for (const value of w.markTypes) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = t(w.markLabel(value));
        mark.append(option);
      }
      mark.disabled = !episode.qa;
      mark.value = episode.annotation?.mark || '';
      const note = document.createElement('input');
      note.type = 'text';
      note.maxLength = 1000;
      note.placeholder = t('qaBatchNote');
      note.value = episode.annotation?.note || '';
      note.disabled = !episode.qa;
      api.describe(note, t('qaBatchNote') + ' · ' + episode.title);
      mark.addEventListener('change', () => w.setMark(episode, mark.value, note.value.trim()));
      note.addEventListener('change', () => {
        editingNote = true;
        w.setMark(episode, mark.value, note.value.trim());
        editingNote = false;
      });
      note.addEventListener('keydown', event => { if (event.key === 'Enter') note.blur(); });
      const duration = qa(episode, 'duration');
      cells(row, [
        open, status, mark, w.number(qa(episode, 'frames'), 0), duration == null ? '—' : api.timeText(duration),
        w.number(qa(episode, 'maxSpanMs'), 3), w.percent(qa(episode, 'within10Rate')), w.number(count(episode, 'synthetic'), 0),
        w.number(count(episode, 'jumps'), 0), w.percent(coverage(episode, 'left')) + ' / ' + w.percent(coverage(episode, 'right')),
        w.number(count(episode, 'sensorGaps'), 0), note
      ]);
      return row;
    }

    function render() {
      progress();
      if (!dialog.open) return;
      summary();
      const selected = filtered();
      const headers = columns.map(([key, name]) => {
        const header = document.createElement('th');
        header.scope = 'col';
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = t(name) + (sortKey === key ? (descending ? ' ↓' : ' ↑') : '');
        if (sortKey === key) header.setAttribute('aria-sort', descending ? 'descending' : 'ascending');
        button.addEventListener('click', () => {
          descending = key === sortKey ? !descending : false;
          sortKey = key;
          render();
          [...$('qaBatchHeaders').querySelectorAll('button')][columns.findIndex(([id]) => id === key)]?.focus();
        });
        header.append(button);
        return header;
      });
      $('qaBatchHeaders').replaceChildren(...headers);
      const rows = document.createDocumentFragment();
      selected.forEach(episode => rows.append(makeRow(episode)));
      $('qaBatchRows').replaceChildren(rows);
      $('qaBatchCsv').disabled = $('qaBatchJson').disabled = !selected.length;
      $('qaBatchEmpty').hidden = !!selected.length || !!job;
      $('qaBatchEmpty').textContent = t(results.length ? 'qaBatchNoMatches' : 'qaBatchEmpty');
    }

    const safeFile = () => (rootName || 'episodes').replace(/[<>:"/\\|?*]/g, '_');
    $('qaBatchCsv').addEventListener('click', () => {
      const rows = [[
        'episode', 'relative_path', 'grade', 'label', 'frames', 'duration_s', 'fps', 'max_span_ms', 'p95_span_ms',
        'within_10ms_rate', 'synthetic_frames', 'sequence_jumps', 'pose_left_coverage', 'pose_right_coverage', 'sensor_gaps', 'note'
      ]];
      for (const ep of filtered()) rows.push([
        ep.title, ep.batchPath, grade(ep), ep.annotation?.mark, qa(ep, 'frames'), qa(ep, 'duration'), qa(ep, 'fps'), qa(ep, 'maxSpanMs'),
        qa(ep, 'p95SpanMs'), qa(ep, 'within10Rate'), count(ep, 'synthetic'), count(ep, 'jumps'), coverage(ep, 'left'),
        coverage(ep, 'right'), count(ep, 'sensorGaps'), ep.annotation?.note
      ]);
      w.download(new Blob(['\ufeff', global.RecordingAnalysis.csvText(rows)], { type: 'text/csv;charset=utf-8' }), safeFile() + '-qa.csv');
    });
    $('qaBatchJson').addEventListener('click', () => {
      const data = { folder: rootName, filters: { grade: $('qaBatchGrade').value || null, label: $('qaBatchMark').value || null },
        episodes: filtered().map(ep => ({
          name: ep.title, relativePath: ep.batchPath, grade: grade(ep), label: ep.annotation?.mark || null,
          note: ep.annotation?.note || '', manifestId: ep.qa?.key || null
        })) };
      w.download(new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' }), safeFile() + '-episodes.json');
    });
    $('qaBatchBtn').addEventListener('click', show);
    $('qaBatchClose').addEventListener('click', () => dialog.close());
    $('qaBatchFolderBtn').addEventListener('click', () => $('batchFolderInput').click());
    $('qaBatchCancelBtn').addEventListener('click', () => job?.abort());
    $('qaBatchGrade').addEventListener('change', render);
    $('qaBatchMark').addEventListener('change', render);
    w.on('annotation', () => { if (!editingNote) render(); });
    w.on('summary', render);
    w.on('locale', render);
    addEventListener('pagehide', event => { if (!event.persisted) job?.abort(); });
  });
})(globalThis);
