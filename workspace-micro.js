/* Frame diagnostics and the video/timeline presentation of the clock bus. */
(function (global) {
  'use strict';
  const M = global.RobotManifest;
  const B = M.bits;
  const $ = id => document.getElementById(id);
  const maskLabels = [
    [B.SYNC_FAIL, 'qaSyncCritical'], [B.SYNC_WARN, 'qaSyncWarning'], [B.SYNTHETIC, 'qaSynthetic'],
    [B.SEQUENCE, 'qaSequence'], [B.CAMERA, 'qaCamera'], [B.GRIPPER, 'qaGripIssue'],
    [B.IMU, 'qaImuIssue'], [B.POSE, 'qaMissingPose'], [B.BUTTON, 'qaButtonEdge']
  ];
  const timelineColors = [
    ['#7f8881', '#4f9f70', '#d7a650', '#cb534a'],
    ['#758078', '#9b7773', '#dd8e47', '#d5544e'],
    ['#758078', '#4e92c3', '#945ab7', '#6874c5'],
    ['#5f986e', '#939992', '#d7a650', '#cf554c']
  ];
  Object.assign(global.ViewerStrings, {
    qaOSD: ['帧信息 OSD', 'Frame OSD'], qaRotate: ['旋转 180°', 'Rotate 180°'], qaMirror: ['水平镜像', 'Mirror horizontally'],
    qaInspector: ['单帧检视器', 'Frame inspector'], qaFrameInspectorToggle: ['开关检视器 (D)', 'Toggle frame inspector (D)'],
    qaInspectEmpty: ['导入带帧清单的会话后查看诊断。', 'Load an episode with a frame manifest to inspect it.'],
    qaSyncDetails: ['同步质量', 'Sync quality'], qaCameraDetails: ['相机明细', 'Camera details'],
    qaSensorDetails: ['夹爪与 IMU', 'Grippers and IMU'], qaCopyFrame: ['复制帧诊断', 'Copy frame report'],
    qaSaveMosaic: ['导出拼接截图', 'Export frame mosaic'], qaCopied: ['帧诊断已复制。', 'Frame report copied.'],
    qaCopyError: ['无法访问剪贴板。可展开 Raw JSON 手动复制。', 'Clipboard unavailable. Open Raw JSON to copy manually.'],
    qaNoImage: ['无可用画面', 'No frame available'], qaScreenshotError: ['无法生成拼接截图。', 'Could not create the frame mosaic.'],
    qaTimeline: ['异常时间轴。自上而下为同步跨度、相机异常、夹爪按键、传感器和 Pose 健康。',
      'Anomaly timeline. Tracks from top to bottom: sync span, camera anomalies, gripper buttons, sensor and pose health.'],
    qaPrevAnomaly: ['上一异常帧 ([)', 'Previous anomalous frame ([)'], qaNextAnomaly: ['下一异常帧 (])', 'Next anomalous frame (])'],
    qaAnomalyTypes: ['异常筛选', 'Anomaly filters'], qaNoAnomaly: ['此方向没有匹配的异常帧。', 'No matching anomalous frame in this direction.'],
    qaSensorHealth: ['传感器告警', 'Sensor warnings'], qaGripIssue: ['夹爪异常', 'Gripper issue'],
    qaImuIssue: ['IMU 异常', 'IMU issue'], qaButtonEdge: ['按键边沿', 'Button edge'],
    qaLoopToggle: ['开关 A–B 循环 (L)', 'Toggle A–B loop (L)'], qaSetLoopFirst: ['请先设置 A 和 B。', 'Set A and B first.'],
    qaSound: ['播放主相机声音', 'Play primary camera audio'],
    qaJumpHelp: ['上一或下一异常帧', 'Previous or next anomalous frame'],
    qaFrameHelp: ['步进一帧 / 十帧', 'Step one / ten frames'],
    qaLoopHelp: ['设置 A / B，开关循环', 'Set A / B, toggle loop'],
    qaMarkHelp: ['人工打标', 'Label an episode']
  });

  function readPreference(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  }
  function store(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }

  global.RobotWorkspace.use(w => {
    const api = w.api;
    const t = api.t;
    const format = value => value === null || value === undefined || Number.isNaN(value) ? '—'
      : typeof value === 'object' ? JSON.stringify(value) : String(value);
    const canvas = $('qaTimeline');
    const timeline = $('qaTimelineBand');
    const cursor = $('qaTimelineCursor');
    const tooltip = $('qaTimelineTip');
    let tileViews = [];
    let focus = null;
    let lastIndex = -2;
    let lastInspect = 0;
    let inspectedIndex = -2;
    let imageGeneration = 0;
    const mosaics = new Set();
    let timelineWidth = 0;
    let timelineDuration = 0;
    let scrub = null;
    let transforms = readPreference('rdv.camera.transforms', {});
    if (!transforms || typeof transforms !== 'object') transforms = {};
    let osd = !!readPreference('rdv.camera.osd', false);
    $('qaOsdBtn').classList.toggle('active', osd);
    $('qaOsdBtn').setAttribute('aria-pressed', String(osd));

    w.transform = key => Object.hasOwn(transforms, key) ? transforms[key] : { rotate: false, mirror: false };
    const fileName = () => (w.session?.source || 'episode').replace(/\.tar$/i, '').replace(/[<>:"/\\|?*]/g, '_');
    const frameName = frame => frame.index < 0 ? '—' : '#' + frame.data.frameIndex[frame.index];
    const reasonText = mask => maskLabels.filter(([bit]) => (mask & bit) && !(bit === B.SYNC_WARN && mask & B.SYNC_FAIL))
      .map(([, key]) => t(key)).join(' · ');

    function orient(tile) {
      const value = w.transform(tile.channel.key);
      const css = 'scaleX(' + (value.mirror ? -1 : 1) + ') rotate(' + (value.rotate ? 180 : 0) + 'deg)';
      tile.video.style.transform = css;
      tile.wrap.style.setProperty('--orientation', css);
      if (tile.rotate) {
        api.setPressed(tile.rotate, !!value.rotate);
        api.setPressed(tile.mirror, !!value.mirror);
      }
    }

    function cameraTool(container, tile, field, glyph, key) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'icon-btn camera-tool';
      button.textContent = glyph;
      api.describe(button, t(key));
      button.addEventListener('click', () => {
        const next = { ...w.transform(tile.channel.key), [field]: !w.transform(tile.channel.key)[field] };
        Object.defineProperty(transforms, tile.channel.key, { value: next, enumerable: true, writable: true, configurable: true });
        store('rdv.camera.transforms', transforms);
        tileViews.filter(view => view.channel.key === tile.channel.key).forEach(orient);
        if (focus?.channel.key === tile.channel.key) orient(focus);
      });
      container.append(button);
      return button;
    }

    w.on('tiles', tiles => {
      tileViews = tiles.map(tile => {
        const tools = document.createElement('div');
        tools.className = 'camera-tools';
        tile.card.querySelector('.expand').before(tools);
        tile.rotate = cameraTool(tools, tile, 'rotate', '↻', 'qaRotate');
        tile.mirror = cameraTool(tools, tile, 'mirror', '⇆', 'qaMirror');
        const hud = document.createElement('span');
        hud.className = 'frame-osd';
        hud.hidden = true;
        const anomaly = document.createElement('span');
        anomaly.className = 'frame-alert';
        anomaly.hidden = true;
        tile.wrap.append(hud, anomaly);
        orient(tile);
        return { ...tile, hud, anomaly, key: M.cameraKey(w.dataset, tile.channel.key) };
      });
      lastIndex = -2;
      flush(w.clock.current);
    });

    w.on('focus', value => {
      focus = value;
      if (focus) orient(focus);
    });
    $('qaOsdBtn').addEventListener('click', () => {
      osd = !osd;
      store('rdv.camera.osd', osd);
      api.setPressed($('qaOsdBtn'), osd);
      lastIndex = -2;
      flush(w.clock.current);
    });

    function updateCameraHuds(frame) {
      if (frame.index === lastIndex) return;
      lastIndex = frame.index;
      const { index, data } = frame;
      for (const tile of tileViews) {
        const usable = index >= 0 && !!tile.key;
        const key = tile.key;
        let alert = '';
        if (usable) {
          if (data.camSyntheticMask[key][index]) alert = 'SYNTHETIC';
          else if (data.camJumpMask[key][index]) alert = 'SEQ JUMP';
        }
        if (tile.card.dataset.anomaly !== alert) {
          tile.card.dataset.anomaly = alert;
          tile.anomaly.hidden = !alert;
          tile.anomaly.textContent = alert;
        }
        const show = osd && usable;
        tile.hud.hidden = !show;
        if (!show) continue;
        const sequence = data.camSeqValid[key][index] ? data.camSeq[key][index] >>> 0 : '—';
        const offset = w.number(data.camOffsetMs[key][index], 3);
        tile.hud.textContent = 'seq:' + sequence + ' | Δt:' + offset + ' ms';
      }
    }

    function drawTimeline() {
      const data = w.dataset;
      const summary = w.session?.qa;
      const visible = !!data?.timeline?.length && !!summary;
      timeline.hidden = !visible;
      $('qaAnomalyControls').hidden = !visible;
      if (!visible) { canvas.width = canvas.height = 0; timelineWidth = 0; return; }
      timelineWidth = canvas.clientWidth;
      timelineDuration = Math.max(api.duration(), summary.duration);
      if (!timelineWidth || !timelineDuration) return;
      const ratio = Math.min(2, devicePixelRatio || 1);
      canvas.width = Math.round(timelineWidth * ratio);
      canvas.height = Math.round(32 * ratio);
      const context = canvas.getContext('2d');
      const count = data.timeline.length / 4;
      const filledWidth = canvas.width * summary.duration / timelineDuration;
      context.clearRect(0, 0, canvas.width, canvas.height);
      for (let row = 0; row < 4; row++) {
        const y = Math.round(row * 8 * ratio);
        const height = Math.max(1, Math.round(7 * ratio));
        context.fillStyle = timelineColors[row][0];
        context.fillRect(0, y, canvas.width, height);
        let first = 0;
        let value = data.timeline[row];
        for (let column = 1; column <= count; column++) {
          const next = data.timeline[column * 4 + row];
          if (next === value) continue;
          const x0 = Math.floor(first * filledWidth / count);
          const x1 = Math.ceil(column * filledWidth / count);
          context.fillStyle = timelineColors[row][value];
          context.fillRect(x0, y, x1 - x0, height);
          first = column;
          value = next;
        }
      }
      moveCursor(w.clock.current);
    }

    function moveCursor(frame) {
      if (timelineWidth) cursor.style.transform = 'translateX(' + Math.min(timelineWidth - 1, timelineWidth * frame.time / timelineDuration) + 'px)';
    }
    function timelinePoint(event) {
      const data = w.dataset;
      if (!data) return -1;
      const box = canvas.getBoundingClientRect();
      return M.nearest(data, (event.clientX - box.left) / box.width * timelineDuration + data.timeSec[0]);
    }
    function hoverTimeline(event, index) {
      if (index < 0) return;
      const data = w.dataset;
      const reason = reasonText(data.frameAnomalyBitmask[index]);
      tooltip.textContent = '#' + data.frameIndex[index] + ' · ' + api.timeText(M.mediaTime(data, index), 3) +
        ' · ' + w.number(data.rawSpanMs[index], 3) + ' ms' + (reason ? ' · ' + reason : '');
      tooltip.hidden = false;
      tooltip.style.left = Math.min(Math.max(8, event.clientX - canvas.getBoundingClientRect().left), Math.max(8, timelineWidth - tooltip.offsetWidth)) + 'px';
    }
    canvas.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !w.dataset) return;
      scrub = event.pointerId;
      canvas.setPointerCapture(scrub);
      const index = timelinePoint(event);
      w.seekFrame(index);
      hoverTimeline(event, index);
    });
    canvas.addEventListener('pointermove', event => {
      const index = timelinePoint(event);
      if (scrub === event.pointerId && index !== w.clock.current.index) w.seekFrame(index, { pause: false });
      hoverTimeline(event, index);
    });
    canvas.addEventListener('lostpointercapture', () => { scrub = null; tooltip.hidden = true; });
    canvas.addEventListener('pointerleave', () => { if (scrub === null) tooltip.hidden = true; });
    const timelineResize = new ResizeObserver(drawTimeline);
    timelineResize.observe(canvas);
    w.on('duration', drawTimeline);

    function jump(direction) {
      const { data, index } = w.clock.current;
      if (!data) return;
      const enabled = [...$('qaAnomalyTypes').querySelectorAll('input:checked')].reduce((mask, input) => mask | Number(input.value), 0);
      for (let next = index + direction; enabled && next >= 0 && next < data.timeSec.length; next += direction) {
        if (data.frameAnomalyBitmask[next] & enabled) { w.seekFrame(next); return; }
      }
      api.toast(t('qaNoAnomaly'));
    }

    $('qaPrevBtn').addEventListener('click', () => jump(-1));
    $('qaNextBtn').addEventListener('click', () => jump(1));
    function toggleInspector() {
      if (!w.session) return;
      $('frameInspector').hidden = !$('frameInspector').hidden;
      $('qaInspectorBtn').setAttribute('aria-expanded', String(!$('frameInspector').hidden));
      inspectedIndex = -2;
      updateInspector(w.clock.current);
    }
    $('qaInspectorBtn').addEventListener('click', toggleInspector);
    $('qaInspectorClose').addEventListener('click', toggleInspector);

    function details(id, values) {
      $(id).replaceChildren(...values.flatMap(([name, value]) => {
        const term = document.createElement('dt');
        const definition = document.createElement('dd');
        term.textContent = name;
        definition.textContent = format(value);
        return [term, definition];
      }));
    }
    function inspectorCameras(data, i, raw) {
      const rows = data.cameraKeys.map(key => {
        const row = document.createElement('tr');
        const cam = raw.cameras?.[key];
        const values = [key, data.camSeqValid[key][i] ? data.camSeq[key][i] >>> 0 : null,
          data.camDeltaValid[key][i] ? data.camDeltaSeq[key][i] : null, w.number(data.camOffsetMs[key][i], 3),
          cam?.synthetic, cam?.reason, cam?.duplication_source_seq, cam?.video_frame_index, cam?.duplication_raw_ns];
        row.append(...values.map((value, index) => {
          const cell = document.createElement(index ? 'td' : 'th');
          if (!index) cell.scope = 'row';
          cell.textContent = format(value);
          return cell;
        }));
        return row;
      });
      $('inspectCameraRows').replaceChildren(...rows);
    }
    function updateInspector(frame) {
      if ($('frameInspector').hidden) return;
      const index = frame.index;
      const data = frame.data;
      const exact = frame.exact || !frame.playing;
      const now = performance.now();
      if (index === inspectedIndex && !exact || !exact && now - lastInspect < 66) return;
      inspectedIndex = index;
      lastInspect = now;
      $('inspectEmpty').hidden = index >= 0;
      $('inspectBody').hidden = index < 0;
      if (index < 0) return;
      const raw = w.clock.raw();
      const sync = raw.sync_quality || {};
      $('inspectIndex').textContent = frameName(frame) + ' · ' + api.timeText(M.mediaTime(data, index), 3);
      $('inspectReasons').textContent = reasonText(data.frameAnomalyBitmask[index]) || '—';
      details('inspectSync', [
        ['raw_span', w.number(data.rawSpanMs[index], 3) + ' ms'], ['source_span_ns', sync.source_span_ns],
        ['within_10ms / within_1ms', format(sync.within_10ms) + ' / ' + format(sync.within_1ms)],
        ['hardware_trigger_verified', sync.hardware_trigger_verified], ['time_basis', sync.time_basis],
        ['sensor_target_basis', sync.sensor_target_basis], ['group_index', raw.group_index],
        ['camera_group_valid', raw.camera_group_valid], ['source_group_synced', raw.source_group_synced],
        ['exposure_midpoint_ns', raw.exposure_midpoint_monotonic_ns], ['sensor_target_ns', raw.sensor_target_monotonic_ns]
      ]);
      inspectorCameras(data, index, raw);
      const sensorRows = [
        ...['umi_left', 'umi_right'].map(side => [side, raw.grippers?.[side]]),
        ['IMU', raw.imu]
      ];
      const fields = ['angle_deg', 'raw', 'button_pressed', 'accel_g', 'gyro_dps', 'dt_ns', 'alpha', 'interpolated', 'gap_exceeded', 'encoder_valid', 'valid'];
      details('inspectSensors', sensorRows.map(([side, sensor]) => [side, sensor ? fields
        .filter(field => sensor[field] !== undefined).map(field => field + '=' + format(sensor[field])).join(' · ') : '—']));
      details('inspectPoses', ['left', 'right'].flatMap(side => {
        if (!data.poseValidMask[side][index]) return [[side, t('qaMissingPose')]];
        const reading = data.pose[side];
        const vector = (values, length) => Array.from(values.subarray(index * length, (index + 1) * length)).map(value => w.number(value, 4)).join(', ');
        return [[side + ' XYZ', vector(reading.position, 3)], [side + ' XYZW', vector(reading.quaternion, 4)]];
      }));
      if ($('inspectRawDetails').open) $('inspectRaw').textContent = JSON.stringify(raw, null, 2);
      else $('inspectRaw').textContent = '';
    }
    $('inspectRawDetails').addEventListener('toggle', () => updateInspector({ ...w.clock.current, exact: true }));

    $('qaCopyBtn').addEventListener('click', async () => {
      const frame = w.clock.current;
      const raw = w.clock.raw();
      if (!raw) return;
      const report = (w.session?.title || '') + ' · ' + frameName(frame) + ' · ' +
        api.timeText(M.mediaTime(frame.data, frame.index), 3) + '\n' +
        (reasonText(frame.data.frameAnomalyBitmask[frame.index]) || '—') + '\n\n' + JSON.stringify(raw, null, 2);
      try { await navigator.clipboard.writeText(report); }
      catch {
        const input = document.createElement('textarea');
        input.value = report;
        $('frameInspector').append(input);
        input.select();
        const copied = document.execCommand('copy');
        input.remove();
        if (!copied) { api.toast(t('qaCopyError'), true); return; }
      }
      api.toast(t('qaCopied'));
    });

    async function waitForSeek(video) {
      if (!video.seeking) return;
      await new Promise(resolve => {
        const timer = setTimeout(done, 450);
        function done() { clearTimeout(timer); video.removeEventListener('seeked', done); resolve(); }
        video.addEventListener('seeked', done, { once: true });
      });
    }

    function drawVideo(context, tile, x, y, width, height) {
      const { video, eye } = tile;
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || tile.wrap.classList.contains('unavailable')) {
        context.fillStyle = '#e1e6de';
        context.fillText(t('qaNoImage'), x + 14, y + 18);
        return;
      }
      const transform = w.transform(tile.channel.key);
      const sourceWidth = video.videoWidth / (eye ? 2 : 1);
      const sourceHeight = video.videoHeight;
      const flipped = !!transform.rotate !== !!transform.mirror;
      const right = eye && (eye === 'right') !== flipped;
      const factor = Math.min(width / sourceWidth, height / sourceHeight);
      context.save();
      context.translate(x + width / 2, y + height / 2);
      context.scale(transform.mirror ? -1 : 1, 1);
      if (transform.rotate) context.rotate(Math.PI);
      context.drawImage(video, right ? sourceWidth : 0, 0, sourceWidth, sourceHeight,
        -sourceWidth * factor / 2, -sourceHeight * factor / 2, sourceWidth * factor, sourceHeight * factor);
      context.restore();
    }

    $('qaMosaicBtn').addEventListener('click', async () => {
      const visible = api.view() === 'analysis' ? [] : api.tiles();
      const tiles = focus ? [focus] : visible;
      if (!tiles.length) { api.toast(t('qaScreenshotError'), true); return; }
      api.pause();
      const id = ++imageGeneration;
      const frame = w.clock.current;
      const number = frame.data.frameIndex[frame.index];
      const header = (w.session?.title || '') + ' ' + frameName(frame) + ' · ' + api.timeText(frame.time, 3);
      const reasons = reasonText(frame.data.frameAnomalyBitmask[frame.index]);
      await Promise.all(tiles.map(tile => waitForSeek(tile.video)));
      if (id !== imageGeneration) return;
      const image = document.createElement('canvas');
      mosaics.add(image);
      const cellWidth = 490;
      const cellHeight = 294;
      const columns = Math.min(3, tiles.length);
      image.width = cellWidth * columns;
      image.height = 62 + Math.ceil(tiles.length / columns) * cellHeight;
      const context = image.getContext('2d');
      context.fillStyle = '#141b17';
      context.fillRect(0, 0, image.width, image.height);
      context.fillStyle = '#f1f4ee';
      context.font = '16px sans-serif';
      context.fillText(header, 12, 24, image.width - 24);
      context.fillStyle = '#ffcc9f';
      context.fillText(reasons || '—', 12, 48, image.width - 24);
      try {
        tiles.forEach((tile, index) => {
          const x = index % columns * cellWidth;
          const y = 62 + Math.floor(index / columns) * cellHeight;
          context.fillStyle = '#f1f4ee';
          context.fillText(api.label(tile.channel) + (tile.eye ? ' · ' + tile.eye : ''), x + 10, y + 20);
          drawVideo(context, tile, x + 5, y + 25, cellWidth - 10, cellHeight - 30);
        });
        image.toBlob(blob => {
          mosaics.delete(image);
          image.width = image.height = 0;
          if (id !== imageGeneration) return;
          if (!blob) { api.toast(t('qaScreenshotError'), true); return; }
          w.download(blob, fileName() + '-frame-' + number + '.png');
        }, 'image/png');
      } catch {
        mosaics.delete(image);
        image.width = image.height = 0;
        api.toast(t('qaScreenshotError'), true);
      }
    });

    function flush(frame) {
      updateCameraHuds(frame);
      moveCursor(frame);
      updateInspector(frame);
    }
    w.clock.subscribe(flush);
    w.on('data', data => {
      for (const tile of tileViews) tile.key = M.cameraKey(data, tile.channel.key);
      inspectedIndex = lastIndex = -2;
      drawTimeline();
    });
    w.on('release', () => {
      tileViews = [];
      focus = null;
      imageGeneration++;
      for (const image of mosaics) image.width = image.height = 0;
      mosaics.clear();
      inspectedIndex = lastIndex = -2;
      tooltip.hidden = true;
      $('inspectBody').hidden = true;
      $('inspectRaw').textContent = '';
      for (const id of ['inspectSync', 'inspectCameraRows', 'inspectSensors', 'inspectPoses']) $(id).replaceChildren();
      drawTimeline();
    });
    w.on('closed', () => {
      $('frameInspector').hidden = true;
      $('qaInspectorBtn').setAttribute('aria-expanded', 'false');
    });
    w.on('locale', () => updateInspector({ ...w.clock.current, exact: true }));

    w.handleKey = event => {
      const key = event.key.toLowerCase();
      if (key === '[' || key === ']') jump(key === '[' ? -1 : 1);
      else if (key === 'i' || key === 'o') api.markLoop(key === 'i' ? 'a' : 'b');
      else if (key === 'l') api.toggleLoop();
      else if (key === 'd') toggleInspector();
      else if (/^[1-3]$/.test(key) && w.session?.qa) w.setMark(w.session, w.markTypes[Number(key)]);
      else return false;
      event.preventDefault();
      return true;
    };
  });
})(globalThis);
