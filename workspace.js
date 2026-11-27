/* Session-level QA, annotation controls and feature lifecycle. */
(function (global) {
  'use strict';

  const M = global.RobotManifest;
  const features = [];
  const $ = id => document.getElementById(id);
  const markTypes = ['', 'accepted', 'review', 'discard'];
  Object.assign(global.ViewerStrings, {
    qaFilter: ['按质检状态筛选', 'Filter by QA status'], qaAll: ['全部', 'All'], qaAbnormal: ['异常', 'Issues'],
    qaNormal: ['正常', 'Pass'], qaReview: ['待复核', 'Review'], qaBatch: ['批量质检总览', 'Batch QA overview'],
    qaTitle: ['会话质检', 'Episode quality'], qaThresholds: ['阈值设置', 'Thresholds'], qaMark: ['人工打标', 'Review label'],
    qaAccepted: ['合格', 'Accepted'], qaDiscard: ['废弃', 'Discard'], qaUnmarked: ['未标注', 'Unlabeled'],
    qaFrames: ['帧数', 'Frames'], qaSync: ['最大 / P95 同步跨度', 'Max / P95 sync span'],
    qaHardware: ['硬触发', 'Hardware trigger'], qaHardwareYes: ['已验证', 'Verified'],
    qaHardwareNo: ['未验证', 'Unverified'], qaUnknown: ['未知', 'Unknown'],
    qaSynthetic: ['补帧', 'Synthetic'], qaSequence: ['Δseq 跳变', 'Δseq jumps'],
    qaPose: ['Pose L / R', 'Pose L / R'], qaGaps: ['传感器断流', 'Sensor gaps'],
    qaCamera: ['相机组无效', 'Invalid camera group'], qaMissingPose: ['Pose 缺失', 'Missing pose'],
    qaSyncCritical: ['同步超限', 'Sync fail'], qaSyncWarning: ['同步警告', 'Sync warning'],
    qaSensor: ['外设采样告警', 'Sensor warning'], qaIncomplete: ['数据不完整', 'Incomplete data'],
    qaNoManifest: ['无帧清单', 'No manifest'], qaManifestError: ['帧清单读取失败', 'Manifest read failed'],
    qaIndexing: ['正在索引帧清单…', 'Indexing frame manifest…'],
    qaWarnMs: ['同步警告（ms）', 'Sync warning (ms)'], qaFailMs: ['同步失败（ms）', 'Sync failure (ms)'],
    qaGripMs: ['夹爪间隔（ms）', 'Gripper interval (ms)'], qaImuMs: ['IMU 间隔（ms）', 'IMU interval (ms)'],
    qaSyntheticPct: ['含补帧的帧占比（%）', 'Frame share with synthetic samples (%)'],
    qaThresholdHint: ['显式的 within_10ms=false 仍判为失败。', 'An explicit within_10ms=false is still a failure.'],
    qaThresholdInvalid: ['同步警告阈值须小于或等于失败阈值。', 'The warning limit must not exceed the failure limit.'],
    qaReset: ['恢复默认', 'Reset defaults']
  });
  const issueLabels = {
    syncFail: 'qaSyncCritical', syncWarn: 'qaSyncWarning', synthetic: 'qaSynthetic', sequence: 'qaSequence',
    cameraInvalid: 'qaCamera', pose: 'qaMissingPose', sensorGaps: 'qaGaps', hardware: 'qaHardwareNo',
    sensorWarnings: 'qaSensor', incomplete: 'qaIncomplete'
  };
  const markLabel = mark => ({ accepted: 'qaAccepted', review: 'qaReview', discard: 'qaDiscard' }[mark] || 'qaUnmarked');

  function create(api) {
    let session = null;
    let dataset = null;
    let loadTask = null;
    let rescanTask = null;
    let filter = 'all';
    let thresholds = M.loadThresholds();
    let forcedIndex = null;
    const clock = M.clock();
    const listeners = new Map();
    const downloads = new Map();

    function on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(listener);
      return () => listeners.get(event)?.delete(listener);
    }
    function emit(event, value) {
      for (const listener of listeners.get(event) || []) listener(value);
    }
    function label(zh, en) { return api.lang() === 'zh' ? zh : en; }
    const number = (value, digits = 1) => Number.isFinite(value) ? api.number(value, digits) : '—';
    const percent = value => Number.isFinite(value) ? number(value * 100) + '%' : '—';
    const issue = key => api.t(issueLabels[key] || 'qaIncomplete');

    const localMarks = {
      async get(episode) {
        try { return JSON.parse(localStorage.getItem('rdv.qa.mark.' + M.annotationKey(episode))) || {}; } catch { return {}; }
      },
      async set(episode, record) {
        try { localStorage.setItem('rdv.qa.mark.' + M.annotationKey(episode), JSON.stringify(record)); } catch {}
      }
    };

    const w = {
      api, clock, on, emit, label, number, percent, issue, markLabel, markTypes, annotationStore: localMarks,
      get session() { return session; }, get dataset() { return dataset; },
      get frameOverride() { return forcedIndex; },
      get thresholds() { return thresholds; },
      scan, activate, release, render, publish, accepts, addCardState, setMark, seekFrame, setDataset, download
    };

    async function scan(episode, signal) {
      if (!episode.manifest) return;
      try {
        const result = await M.run(episode.manifest, { summaryOnly: true, thresholds, fps: episode.fps, signal });
        episode.qa = result.summary;
        episode.qaError = null;
        if (!episode.annotation) episode.annotation = await w.annotationStore.get(episode);
      } catch (error) {
        if (signal?.aborted) throw error;
        episode.qaError = error.message || String(error);
      }
    }

    function publish(exact = false, index) {
      if (index !== undefined) forcedIndex = index;
      if (!dataset || !exact || (api.playing() && index == null)) forcedIndex = null;
      clock.publish(dataset, api.time(), api.playing(), exact, forcedIndex);
    }

    function setDataset(value) {
      dataset = value;
      forcedIndex = null;
      emit('data', value);
      publish(true);
    }

    function release() {
      loadTask?.abort();
      loadTask = null;
      dataset = null;
      session = null;
      for (const [url, timer] of downloads) {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
      }
      downloads.clear();
      emit('release');
      publish(true);
    }

    function download(blob, name) {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
      downloads.set(url, setTimeout(() => {
        downloads.delete(url);
        URL.revokeObjectURL(url);
      }, 1500));
    }

    async function activate(episode) {
      session = episode;
      render();
      if (!episode?.manifest) return;
      const job = new AbortController();
      loadTask?.abort();
      loadTask = job;
      render();
      try {
        const result = await M.run(episode.manifest, { thresholds, fps: episode.fps, signal: job.signal });
        if (loadTask !== job || session !== episode) return;
        loadTask = null;
        episode.qa = result.summary;
        episode.qaError = null;
        if (!episode.annotation) episode.annotation = await w.annotationStore.get(episode);
        if (job.signal.aborted || session !== episode) return;
        setDataset(result.dataset);
        api.refreshDuration();
        api.refreshSidebar();
        render();
      } catch (error) {
        if (job.signal.aborted || session !== episode) return;
        loadTask = null;
        episode.qaError = error.message || String(error);
        api.refreshSidebar();
        render();
      }
    }

    function seekFrame(index, options = {}) {
      if (!dataset || index < 0 || index >= dataset.timeSec.length) return false;
      if (options.pause !== false) api.pause();
      api.seek(M.mediaTime(dataset, index), index);
      return true;
    }

    function accepts(episode) {
      if (filter === 'normal') return episode.qa?.grade === 'PASS';
      if (filter === 'issues') return episode.qaError || episode.qa?.grade === 'WARN' || episode.qa?.grade === 'FAIL';
      if (filter === 'review') return episode.annotation?.mark === 'review';
      return true;
    }

    function addCardState(button, episode) {
      const grade = episode.qa?.grade;
      if (!grade && !episode.qaError && !episode.annotation?.mark) return;
      const count = button.querySelector('.recording-count');
      count.dataset.grade = grade || 'UNKNOWN';
      if (grade) {
        count.textContent = grade;
        api.describe(count, api.t('qaTitle') + ' · ' + grade);
      }
      const labels = [...(episode.qa?.issues || [])].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([key]) => issue(key));
      if (episode.qaError) labels.push(api.t('qaManifestError'));
      if (episode.annotation?.mark) labels.unshift(api.t(markLabel(episode.annotation.mark)));
      if (!labels.length) return;
      const small = document.createElement('small');
      small.className = 'recording-issues';
      small.textContent = labels.join(' · ');
      small.title = small.textContent;
      button.querySelector('.recording-copy').append(small);
    }

    async function setMark(episode, mark, note = episode?.annotation?.note || '') {
      if (!episode?.qa || !markTypes.includes(mark)) return;
      const record = { mark, note, updatedAt: new Date().toISOString() };
      episode.annotation = record;
      render();
      api.refreshSidebar();
      emit('annotation', episode);
      await w.annotationStore.set(episode, record);
    }

    function render() {
      if (!session) return;
      const qa = session.qa;
      const values = $('qaValues');
      values.replaceChildren();
      if (qa) {
        const { count } = qa;
        const grade = document.createElement('strong');
        grade.className = 'qa-grade';
        grade.dataset.grade = qa.grade;
        grade.textContent = qa.grade;
        values.append(grade);
        const hardware = qa.hardware === null ? 'qaUnknown' : qa.hardware ? 'qaHardwareYes' : 'qaHardwareNo';
        const metrics = [
          ['qaFrames', number(qa.frames, 0) + ' / ' + api.timeText(qa.duration) + ' / ' + number(qa.fps) + ' fps'],
          ['qaSync', number(qa.maxSpanMs, 3) + ' / ' + number(qa.p95SpanMs, 3) + ' ms'],
          ['≤10 ms', percent(qa.within10Rate)],
          ['qaHardware', api.t(hardware), qa.hardware === false ? 'WARN' : ''],
          ['qaSynthetic', number(count.synthetic, 0)], ['qaSequence', number(count.jumps, 0)],
          ['qaPose', percent(count.poseLeft / qa.frames) + ' / ' + percent(count.poseRight / qa.frames)],
          ['qaGaps', number(count.sensorGaps, 0)]
        ];
        for (const [key, value, kind] of metrics) {
          const chip = document.createElement('span');
          chip.className = 'qa-chip';
          if (kind) chip.dataset.grade = kind;
          const title = document.createElement('span');
          title.textContent = api.t(key);
          const data = document.createElement('b');
          data.textContent = value;
          chip.append(title, data);
          values.append(chip);
        }
      } else {
        const hint = document.createElement('span');
        hint.className = 'qa-muted';
        hint.textContent = api.t(session.qaError ? 'qaManifestError' : loadTask ? 'qaIndexing' : 'qaNoManifest');
        if (session.qaError) hint.title = session.qaError;
        values.append(hint);
      }
      $('qaIndexStatus').hidden = !loadTask || !qa;
      $('qaThresholdBtn').disabled = !session.manifest;
      for (const button of document.querySelectorAll('[data-qa-mark]')) {
        button.disabled = !qa;
        api.setPressed(button, !!qa && session.annotation?.mark === button.dataset.qaMark);
      }
    }

    function fillThresholds(values = thresholds) {
      for (const input of $('qaThresholdForm').querySelectorAll('input')) input.value = values[input.name];
    }

    async function updateThresholds(values) {
      thresholds = values;
      try { localStorage.setItem('rdv.qa.thresholds', JSON.stringify(values)); } catch {}
      rescanTask?.abort();
      const job = new AbortController();
      rescanTask = job;
      if (session?.manifest) activate(session);
      emit('thresholds', values);
      for (const episode of api.sessions()) {
        if (episode === session || !episode.manifest) continue;
        try { await scan(episode, job.signal); }
        catch { if (job.signal.aborted) return; }
        if (job.signal.aborted) return;
        api.refreshSidebar();
        emit('summary', episode);
      }
      if (rescanTask === job) rescanTask = null;
    }

    $('qaFilters').addEventListener('click', event => {
      const button = event.target.closest('[data-qa-filter]');
      if (!button) return;
      filter = button.dataset.qaFilter;
      for (const item of $('qaFilters').querySelectorAll('button')) api.setPressed(item, button === item);
      api.refreshSidebar();
    });
    $('qaMarks').addEventListener('click', event => {
      const button = event.target.closest('[data-qa-mark]');
      if (button && session) setMark(session, button.dataset.qaMark);
    });
    $('qaThresholdBtn').addEventListener('click', () => {
      fillThresholds();
      $('qaThresholdDialog').showModal();
    });
    $('qaThresholdClose').addEventListener('click', () => $('qaThresholdDialog').close());
    $('qaResetBtn').addEventListener('click', () => fillThresholds(M.defaults));
    $('qaThresholdForm').addEventListener('submit', event => {
      event.preventDefault();
      const form = event.currentTarget;
      const values = Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, Number(value)]));
      if (values.warnMs > values.failMs) { api.toast(api.t('qaThresholdInvalid'), true); return; }
      $('qaThresholdDialog').close();
      updateThresholds(values);
    });
    addEventListener('pagehide', event => { if (!event.persisted) { rescanTask?.abort(); release(); } });
    for (const install of features) install(w);
    return w;
  }

  global.RobotWorkspace = { create, use: feature => features.push(feature) };
})(globalThis);
