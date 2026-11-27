/* Shared uPlot views. Playback cursors are DOM overlays and never redraw a plot. */
(function (global) {
  'use strict';
  const M = global.RobotManifest;
  const S = M.sensorFlags;
  const $ = id => document.getElementById(id);
  const colors = ['#3a8d70', '#4d82c7', '#c5784e', '#8d65b2', '#c08f32', '#2b91a0', '#c2658b', '#888c8b'];
  const gripperColors = { left: '#287d61', right: '#356fc0' };
  const gripperMetrics = { angleDeg: 'qaPlotAngle', raw: 'qaPlotRaw', angleSpeed: 'qaPlotSpeed' };
  const gripperUnits = { angleDeg: '°', raw: '', angleSpeed: '°/s' };
  const referenceColor = '#a78351';
  const labels = { offsets: 'qaPlotOffsets', sequence: 'qaPlotSequence', grippers: 'qaPlotGrippers', imu: 'qaPlotImu' };
  Object.assign(global.ViewerStrings, {
    qaLinked: ['联动分析', 'Linked analysis'], qaSplitHandle: ['调整相机与曲线面板高度', 'Resize camera and chart panes'],
    qaPlotOffsets: ['多相机时间偏差', 'Camera time offsets'], qaPlotSequence: ['序列与补帧', 'Sequence and synthetic frames'],
    qaPlotGrippers: ['夹爪开合与按键', 'Gripper motion and button presses'], qaPlotImu: ['IMU 与采样健康', 'IMU and sampling health'],
    qaPlotHelp: ['拖动定位。Shift + 拖动同步框选缩放，双击重置。', 'Drag to seek. Shift-drag to zoom all plots. Double-click to reset.'],
    qaPlotHover: ['悬停预览', 'Preview on hover'], qaPlotZoom: ['框选缩放', 'Drag to zoom'],
    qaPlotReset: ['重置缩放', 'Reset zoom'], qaPlotSpan: ['叠加同步跨度', 'Overlay sync span'],
    qaPlotAngle: ['角度 (°)', 'Angle (°)'], qaPlotRaw: ['原始码值', 'Raw code'], qaPlotSpeed: ['角速度 (°/s)', 'Angular velocity (°/s)'],
    qaPlotAxes: ['IMU 6 轴', 'IMU axes'], qaPlotDt: ['采样间隔 (ms)', 'Sample interval (ms)'],
    qaPlotLeft: ['左夹爪', 'Left gripper'], qaPlotRight: ['右夹爪', 'Right gripper'],
    qaPlotLeftButton: ['左侧键', 'Left button'], qaPlotRightButton: ['右侧键', 'Right button'],
    qaPlotButtonTracks: ['色带表示对应夹爪的按钮处于按下状态。', 'Colored intervals show when the corresponding button was held.'],
    qaPlotGripperNote: ['曲线对比左右夹爪的开合变化。', 'The lines compare how the left and right grippers move.'],
    qaPlotOffsetNote: ['每条线表示相机相对传感器目标时间的偏差。正值较晚，负值较早。', 'Each line is a camera’s offset from the sensor target time. Positive is later, negative is earlier.'],
    qaPlotTimeAxis: ['回放时间 (s)', 'Playback time (s)'], qaPlotOffsetAxis: ['时间偏差 (ms)', 'Time offset (ms)'],
    qaPlotReference: ['±5 ms 参考线', '±5 ms reference'], qaPlotSeries: ['选择显示的曲线', 'Choose visible traces'],
    qaPlotSpanPositive: ['同步跨度 +', 'Sync span +'], qaPlotSpanNegative: ['同步跨度 −', 'Sync span −'],
    qaPlotNoData: ['此会话暂无帧清单曲线。', 'No frame-manifest traces are available for this episode.'],
    qaPlotChoose: ['选择至少一张图表。', 'Select at least one chart.'],
    qaPlotUnavailable: ['本地图表库无法加载。', 'The offline chart library could not be loaded.']
  });

  function buildSampleIndices(data, min, max) {
    const origin = data.timeSec[0];
    const length = data.timeSec.length;
    const first = Math.max(0, M.lowerBound(data.timeSec, min + origin) - 1);
    const last = Math.min(length, M.lowerBound(data.timeSec, max + origin) + 1);
    const step = Math.max(1, Math.ceil((last - first) / 5000));
    const result = [];
    const notable = data.notableFrames;
    for (let i = first; i < last; i += step) {
      result.push(i);
      if (step > 1) {
        const at = M.lowerBound(notable, i + 1);
        if (notable[at] < Math.min(i + step, last)) result.push(notable[at]);
      }
    }
    if (result.at(-1) !== last - 1) result.push(last - 1);
    return result;
  }

  global.RobotWorkspace.use(w => {
    const api = w.api;
    const t = api.t;
    const root = document.createElement('div');
    root.className = 'qa-plots';
    const videoPane = $('cameraView');
    const shell = $('mediaWorkspace');
    const handle = $('linkedHandle');
    let ratio = 49;
    try { ratio = Math.min(75, Math.max(25, Number(localStorage.getItem('rdv.linked.ratio')) || 49)); } catch {}
    const selections = {
      linked: new Set(['offsets', 'grippers']),
      analysis: new Set(Object.keys(labels))
    };
    let viewport = null;
    let activePlots = [];
    let grip = 'angleDeg';
    let imuMode = 'axes';
    let envelope = false;
    let hover = false;
    let zoomMode = false;
    const hiddenSeries = { offsets: new Set(), grippers: new Set() };

    function addButton(parent, label, click, pressed) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn';
      button.textContent = t(label);
      if (pressed !== undefined) api.setPressed(button, pressed);
      button.addEventListener('click', click);
      parent.append(button);
      return button;
    }

    function domSelect(options, selected, label, change) {
      const select = document.createElement('select');
      api.describe(select, t(label));
      for (const [key, value] of options) {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = t(value);
        select.append(option);
      }
      select.value = selected;
      select.addEventListener('change', () => change(select.value));
      return select;
    }

    function layout() {
      if (api.view() !== 'linked' || $('session').hidden) return;
      const scroll = $('mainScroll');
      const available = scroll.getBoundingClientRect().bottom - shell.getBoundingClientRect().top + scroll.scrollTop - 8;
      const height = Math.max(422, Math.floor(available));
      shell.style.setProperty('--linked-height', height + 'px');
      videoPane.style.setProperty('--linked-video-height', Math.round(height * ratio / 100) + 'px');
      handle.setAttribute('aria-valuenow', Math.round(ratio));
      api.updateGrid();
    }

    const layoutObserver = new ResizeObserver(layout);
    layoutObserver.observe($('mainScroll'));
    layoutObserver.observe(document.querySelector('.qa-strip'));
    function setRatio(value) {
      ratio = Math.min(75, Math.max(25, value));
      layout();
    }
    let resizing = -1;
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      resizing = event.pointerId;
      handle.setPointerCapture(resizing);
    });
    handle.addEventListener('pointermove', event => {
      if (event.pointerId !== resizing) return;
      const bounds = shell.getBoundingClientRect();
      setRatio(100 * (event.clientY - bounds.top) / bounds.height);
    });
    function keepRatio() { try { localStorage.setItem('rdv.linked.ratio', String(ratio)); } catch {} }
    handle.addEventListener('lostpointercapture', () => { resizing = -1; keepRatio(); });
    handle.addEventListener('keydown', event => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      setRatio(ratio + (event.key === 'ArrowUp' ? -4 : 4));
      keepRatio();
    });

    function destroy() {
      activePlots.forEach(view => {
        view.resize.disconnect();
        view.plot.destroy();
        if (view.tracks) view.tracks.canvas.width = view.tracks.canvas.height = 0;
      });
      activePlots = [];
      root.replaceChildren();
    }

    function models(kind, data) {
      const at = (key, values, scale = 'y') => ({ name: key, values, scale });
      if (kind === 'offsets') {
        const captions = new Map((w.session?.channels || []).map(channel => [M.cameraKey(data, channel.key), api.label(channel)]));
        const lines = data.cameraKeys.map(key => ({
          ...at(captions.get(key) || key, i => data.camOffsetMs[key][i]), key, title: key, unit: 'ms'
        }));
        if (envelope) {
          lines.push({ ...at(t('qaPlotSpanPositive'), i => data.rawSpanMs[i]), key: 'span+', unit: 'ms', color: '#8d948e', dash: [4, 3] },
            { ...at(t('qaPlotSpanNegative'), i => -data.rawSpanMs[i]), key: 'span-', unit: 'ms', color: '#8d948e', dash: [4, 3] });
        }
        return lines;
      }
      if (kind === 'sequence') {
        return [
          ...data.cameraKeys.map(key => at(key, i => data.camDeltaValid[key][i] && data.expectedSeqStep[key] != null
            ? data.camDeltaSeq[key][i] - data.expectedSeqStep[key] : null)),
          { ...at('SYNTHETIC', i => data.frameAnomalyBitmask[i] & M.bits.SYNTHETIC ? 0 : null), points: true, color: '#d94e46' }
        ];
      }
      const left = data.grippers.umi_left;
      const right = data.grippers.umi_right;
      if (kind === 'grippers') {
        const value = (reading, i) => grip === 'raw' && !(reading.flags[i] & S.RAW) ? null : reading[grip][i];
        return [['left', 'qaPlotLeft', left], ['right', 'qaPlotRight', right]].map(([side, name, reading]) => ({
          ...at(t(name), i => value(reading, i)), key: side, color: gripperColors[side], unit: gripperUnits[grip]
        }));
      }
      if (imuMode === 'dt') {
        return [
          at(t('qaPlotLeft'), i => left.dtMs[i]), at(t('qaPlotRight'), i => right.dtMs[i]), at('IMU', i => data.imu.dtMs[i]),
          { ...at('gap_exceeded', i => {
            const sources = [left, right, data.imu].filter(track => track.flags[i] & S.GAP);
            return sources.length ? Math.max(0, ...sources.map(track => Number.isFinite(track.dtMs[i]) ? track.dtMs[i] : 0)) : null;
          }), points: true, color: '#d94e46' }
        ];
      }
      return ['ax', 'ay', 'az', 'accelNorm', 'gx', 'gy', 'gz']
        .map((key, index) => at(key === 'accelNorm' ? '‖a‖' : key, i => data.imu[key][i], index < 4 ? 'y' : 'gyro'));
    }

    function range() {
      return viewport || { min: 0, max: Math.max(.001, w.session.qa.duration) };
    }
    function packed(data, lines, bounds) {
      const origin = data.timeSec[0];
      const indices = buildSampleIndices(data, bounds.min, bounds.max);
      return [indices.map(i => data.timeSec[i] - origin), ...lines.map(line => indices.map(i => {
        const value = line.values(i);
        return Number.isFinite(value) ? value : null;
      }))];
    }

    function zoom(bounds) {
      const duration = w.session?.qa?.duration;
      if (!duration) return;
      viewport = bounds ? {
        min: Math.max(0, Math.min(duration, bounds.min)),
        max: Math.max(0, Math.min(duration, bounds.max))
      } : null;
      if (viewport && viewport.max - viewport.min < 1e-5) { viewport = null; return; }
      const current = range();
      for (const view of activePlots) {
        view.plot.setData(packed(view.data, view.lines, current), false);
        view.plot.setScale('x', current);
      }
      moveCursors(w.clock.current);
    }

    function drawReferences(plot, kind) {
      const ctx = plot.ctx;
      const { left, top, width, height } = plot.bbox;
      ctx.save();
      ctx.beginPath();
      ctx.rect(left, top, width, height);
      ctx.clip();
      const references = kind === 'offsets' ? [-5, 5] : kind === 'imu' && imuMode === 'dt'
        ? [w.thresholds.gripperMs, w.thresholds.imuMs] : [];
      ctx.strokeStyle = referenceColor;
      ctx.setLineDash([5, 4]);
      for (const reading of references) {
        const y = plot.valToPos(reading, 'y', true);
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(left + width, y);
        ctx.stroke();
      }
      ctx.restore();
    }

    function buttonTracks() {
      const group = document.createElement('div');
      group.className = 'qa-gripper-buttons';
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', t('qaPlotButtonTracks'));
      const labels = document.createElement('div');
      labels.className = 'qa-gripper-button-labels';
      for (const [side, title] of [['left', 'qaPlotLeftButton'], ['right', 'qaPlotRightButton']]) {
        const label = document.createElement('span');
        label.style.setProperty('--series-color', gripperColors[side]);
        label.textContent = t(title);
        labels.append(label);
      }
      const rails = document.createElement('div');
      rails.className = 'qa-gripper-rails';
      const canvas = document.createElement('canvas');
      canvas.setAttribute('aria-hidden', 'true');
      const cursor = document.createElement('i');
      cursor.className = 'qa-plot-cursor vertical';
      rails.append(canvas, cursor);
      group.append(labels, rails);
      return { group, rails, canvas, cursor };
    }

    function drawButtonTracks(plot, data, tracks) {
      const { rails, canvas } = tracks;
      const width = plot.over.clientWidth;
      if (width <= 0) return;
      tracks.group.style.setProperty('--track-left', plot.over.offsetLeft + 'px');
      rails.style.width = width + 'px';
      const dpr = global.devicePixelRatio || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(28 * dpr);
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const { min, max } = plot.scales.x;
      const first = M.lowerBound(data.timeSec, min + data.timeSec[0]);
      const last = M.lowerBound(data.timeSec, max + data.timeSec[0]);
      const color = getComputedStyle(tracks.group).getPropertyValue('--line').trim();
      for (const [side, row] of [['left', 0], ['right', 1]]) {
        const y = row * 14 + 2;
        ctx.fillStyle = color;
        ctx.fillRect(0, y, width, 10);
        const spans = data.buttonRanges[side];
        ctx.fillStyle = gripperColors[side];
        for (let j = Math.floor(M.lowerBound(spans, first) / 2) * 2; j < spans.length && spans[j] <= last; j += 2) {
          const begin = M.mediaTime(data, spans[j]);
          const finish = spans[j + 1] < data.timeSec.length ? M.mediaTime(data, spans[j + 1]) : w.session.qa.duration;
          const x = Math.max(0, plot.valToPos(begin, 'x'));
          const end = Math.min(width, plot.valToPos(finish, 'x'));
          if (end > x) ctx.fillRect(x, y, Math.max(1, end - x), 10);
        }
      }
    }

    function plotLegend(plot, kind, lines) {
      const legend = document.createElement('div');
      legend.className = 'qa-read-legend';
      legend.setAttribute('role', 'group');
      legend.setAttribute('aria-label', t('qaPlotSeries'));
      const hidden = hiddenSeries[kind];
      for (const [i, line] of lines.entries()) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = line.name;
        button.title = line.title || line.name;
        button.className = 'qa-legend-item';
        button.style.setProperty('--series-color', line.color || colors[i % colors.length]);
        if (line.dash) button.dataset.stroke = 'dashed';
        api.setPressed(button, !hidden.has(line.key));
        button.addEventListener('click', () => {
          const show = hidden.has(line.key);
          if (show) hidden.delete(line.key);
          else hidden.add(line.key);
          api.setPressed(button, show);
          plot.setSeries(i + 1, { show });
          moveCursors(w.clock.current);
        });
        legend.append(button);
      }
      if (kind === 'offsets') {
        const note = document.createElement('span');
        note.className = 'qa-legend-item qa-legend-reference';
        note.dataset.stroke = 'dashed';
        note.style.setProperty('--series-color', referenceColor);
        note.textContent = t('qaPlotReference');
        legend.append(note);
      }
      return legend;
    }

    function seqTooltip(node, data, index) {
      const raw = w.clock.raw(index);
      node.textContent = '#' + data.frameIndex[index] + ' · ' + api.timeText(M.mediaTime(data, index), 3) + '\n' +
        data.cameraKeys.map(key => {
          const row = raw?.cameras?.[key];
          const delta = data.camDeltaValid[key][index] ? data.camDeltaSeq[key][index] : '—';
          return key + '  seq ' + (row?.sequence ?? '—') + '  Δ ' + delta +
            (row?.reason ? ' · ' + row.reason : '') + (row?.duplication_source_seq != null ? ' · dup ' + row.duplication_source_seq : '');
        }).join('\n');
    }

    function readingTooltip(view, index) {
      const { tooltip, data, lines, plot } = view;
      tooltip.textContent = '#' + data.frameIndex[index] + ' · ' + api.timeText(M.mediaTime(data, index), 3) + '\n' +
        lines.filter((_, i) => plot.series[i + 1].show).map(line => {
          const value = line.values(index);
          const unit = Number.isFinite(value) && line.unit ? ' ' + line.unit : '';
          return line.name + '  ' + w.number(value, 3) + unit;
        }).join('\n');
    }

    function translatePointer(view, event) {
      const box = view.plot.over.getBoundingClientRect();
      return Math.min(box.width, Math.max(0, event.clientX - box.left));
    }

    function installPointer(view) {
      const { plot, data, kind, selection, tooltip } = view;
      const surface = plot.over;
      let drag = null;
      let lastHover = -1;
      const indexAt = x => M.nearest(data, plot.posToVal(x, 'x') + data.timeSec[0]);
      function seek(x, pause) {
        const index = indexAt(x);
        if (index !== w.clock.current.index || pause && api.playing()) w.seekFrame(index, { pause });
      }
      surface.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        const x = translatePointer(view, event);
        drag = { pointer: event.pointerId, start: x, zoom: event.shiftKey || zoomMode };
        surface.setPointerCapture(event.pointerId);
        if (!drag.zoom) seek(x, true);
      });
      surface.addEventListener('pointermove', event => {
        const x = translatePointer(view, event);
        if (drag?.pointer === event.pointerId) {
          if (drag.zoom) {
            selection.hidden = false;
            selection.style.left = Math.min(drag.start, x) + 'px';
            selection.style.width = Math.abs(drag.start - x) + 'px';
          } else seek(x, false);
        } else if (hover && !zoomMode && !event.buttons) seek(x, true);
        if (kind === 'sequence' || hiddenSeries[kind]) {
          const index = indexAt(x);
          if (index !== lastHover || tooltip.hidden) {
            if (kind === 'sequence') seqTooltip(tooltip, data, index);
            else readingTooltip(view, index);
            lastHover = index;
          }
          tooltip.hidden = false;
          tooltip.style.left = Math.max(0, Math.min(x, surface.clientWidth - tooltip.offsetWidth)) + 'px';
        }
      });
      surface.addEventListener('pointerup', event => {
        if (drag?.pointer !== event.pointerId) return;
        const x = translatePointer(view, event);
        if (drag.zoom) {
          if (Math.abs(x - drag.start) > 7) zoom({
            min: plot.posToVal(Math.min(x, drag.start), 'x'), max: plot.posToVal(Math.max(x, drag.start), 'x')
          });
          else seek(x, true);
        }
        drag = null;
        selection.hidden = true;
      });
      surface.addEventListener('lostpointercapture', () => { drag = null; selection.hidden = true; });
      surface.addEventListener('pointerleave', () => { tooltip.hidden = true; });
      surface.addEventListener('dblclick', () => zoom(null));
      view.tracks?.rails.addEventListener('click', event => seek(translatePointer(view, event), true));
    }

    function makePlot(kind, data) {
      const card = document.createElement('section');
      card.className = 'panel qa-plot-card';
      card.dataset.plot = kind;
      const heading = document.createElement('header');
      const title = document.createElement('h3');
      title.textContent = t(labels[kind]);
      heading.append(title);
      const redraw = () => render();
      if (kind === 'offsets') addButton(heading, 'qaPlotSpan', () => { envelope = !envelope; redraw(); }, envelope);
      if (kind === 'grippers') heading.append(domSelect(Object.entries(gripperMetrics), grip, 'qaPlotGrippers', value => { grip = value; redraw(); }));
      if (kind === 'imu') heading.append(domSelect([
        ['axes', 'qaPlotAxes'], ['dt', 'qaPlotDt']
      ], imuMode, 'qaPlotImu', value => { imuMode = value; redraw(); }));
      const chart = document.createElement('div');
      chart.className = 'qa-plot-surface';
      const guide = kind === 'grippers' || kind === 'offsets';
      card.append(heading);
      if (guide) {
        const note = document.createElement('p');
        note.className = 'qa-plot-caption';
        note.textContent = t(kind === 'grippers' ? 'qaPlotGripperNote' : 'qaPlotOffsetNote');
        card.append(note);
      }
      card.append(chart);
      const tracks = kind === 'grippers' ? buttonTracks() : null;
      if (tracks) {
        const note = document.createElement('p');
        note.className = 'qa-gripper-track-note';
        note.textContent = t('qaPlotButtonTracks');
        card.append(tracks.group, note);
      }
      root.append(card);
      const lines = models(kind, data);
      const axisColor = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim();
      const gridColor = getComputedStyle(document.documentElement).getPropertyValue('--line').trim();
      const axis = { stroke: axisColor, grid: { stroke: gridColor }, ticks: { stroke: gridColor } };
      const twoAxes = kind === 'imu' && imuMode === 'axes';
      const y = { auto: true };
      const safe = (reading, fallback) => Number.isFinite(reading) ? reading : fallback;
      if (kind === 'offsets') y.range = (_, min, max) => [Math.min(-5.5, safe(min, -5.5)), Math.max(5.5, safe(max, 5.5))];
      if (kind === 'imu' && imuMode === 'dt') y.range = (_, min, max) =>
        [Math.min(0, safe(min, 0)), Math.max(w.thresholds.gripperMs, w.thresholds.imuMs, safe(max, 0)) * 1.1];
      const height = guide ? 190 : 175;
      const plot = new global.uPlot({
        width: Math.max(250, chart.clientWidth), height,
        scales: { x: { time: false }, y, ...(twoAxes ? { gyro: { auto: true } } : {}) },
        cursor: { x: false, y: false, drag: { x: false, y: false, setScale: false }, points: { show: false } },
        legend: { show: !guide, live: false },
        axes: [
          { ...axis, size: 24, ...(guide ? { label: t('qaPlotTimeAxis'), labelSize: 16 } : {}),
            values: (_, ticks) => ticks.map(value => w.number(value, 3) + (guide ? '' : ' s')) },
          { ...axis, size: 48, ...(guide ? {
            label: t(kind === 'offsets' ? 'qaPlotOffsetAxis' : gripperMetrics[grip]), labelSize: 18
          } : {}) },
          ...(twoAxes ? [{ ...axis, scale: 'gyro', side: 1, size: 39, grid: { show: false } }] : [])
        ],
        series: [{}, ...lines.map((line, i) => ({
          label: line.name, scale: line.scale, stroke: line.color || colors[i % colors.length], width: line.points ? 0 : 1.4,
          show: !hiddenSeries[kind]?.has(line.key),
          dash: line.dash, paths: line.points ? () => null : undefined,
          points: line.points ? { show: true, size: 7, fill: line.color, stroke: line.color } : { show: false }
        }))],
        hooks: {
          drawAxes: [instance => drawReferences(instance, kind)],
          ...(tracks ? { draw: [instance => drawButtonTracks(instance, data, tracks)] } : {})
        }
      }, packed(data, lines, range()), chart);
      if (guide) chart.before(plotLegend(plot, kind, lines));
      plot.setScale('x', range());
      const vertical = document.createElement('i');
      const horizontal = document.createElement('i');
      vertical.className = 'qa-plot-cursor vertical';
      horizontal.className = 'qa-plot-cursor horizontal';
      const selection = document.createElement('div');
      selection.className = 'qa-plot-selection';
      selection.hidden = true;
      const tooltip = document.createElement('pre');
      tooltip.className = 'qa-plot-tip';
      tooltip.hidden = true;
      plot.over.append(vertical, horizontal, selection, tooltip);
      const resize = new ResizeObserver(() => {
        const newWidth = Math.max(250, chart.clientWidth);
        if (plot.width !== newWidth) plot.setSize({ width: newWidth, height });
        moveCursors(w.clock.current);
      });
      resize.observe(chart);
      const view = { plot, data, lines, vertical, horizontal, resize, selection, tooltip, kind, tracks };
      installPointer(view);
      return view;
    }

    function moveCursors(frame) {
      if (frame.index < 0) return;
      for (const { plot, lines, vertical, horizontal, tracks } of activePlots) {
        const x = plot.scales.x;
        const visible = frame.time >= x.min && frame.time <= x.max;
        vertical.hidden = !visible;
        if (visible) vertical.style.transform = 'translateX(' + plot.valToPos(frame.time, 'x') + 'px)';
        if (tracks) {
          tracks.cursor.hidden = !visible;
          if (visible) tracks.cursor.style.transform = vertical.style.transform;
        }
        const index = lines.findIndex((line, i) => plot.series[i + 1].show && Number.isFinite(line.values(frame.index)));
        horizontal.hidden = !visible || index < 0;
        if (!horizontal.hidden) {
          const line = lines[index];
          horizontal.style.transform = 'translateY(' + plot.valToPos(line.values(frame.index), line.scale) + 'px)';
        }
      }
    }

    function render() {
      destroy();
      const view = api.view();
      if (!['linked', 'analysis'].includes(view) || !api.session()) { root.remove(); return; }
      const mount = $(view === 'linked' ? 'linkedPlotMount' : 'analysisPlotMount');
      mount.append(root);
      layout();
      const data = w.dataset;
      if (!data || !global.uPlot) {
        if (view === 'analysis' && !w.session?.manifest) { root.remove(); return; }
        const note = document.createElement('p');
        note.className = 'panel qa-plot-empty';
        note.textContent = t(!global.uPlot ? 'qaPlotUnavailable' : w.session?.qa ? 'qaIndexing' : 'qaPlotNoData');
        root.append(note);
        return;
      }
      const toolbar = document.createElement('div');
      toolbar.className = 'qa-plot-controls';
      const set = selections[view];
      for (const kind of Object.keys(labels)) {
        const label = document.createElement('label');
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = set.has(kind);
        check.addEventListener('change', () => { if (check.checked) set.add(kind); else set.delete(kind); render(); });
        label.append(check, document.createTextNode(t(labels[kind])));
        toolbar.append(label);
      }
      const a = addButton(toolbar, 'qaPlotHover', () => { hover = !hover; api.setPressed(a, hover); }, hover);
      const b = addButton(toolbar, 'qaPlotZoom', () => { zoomMode = !zoomMode; api.setPressed(b, zoomMode); }, zoomMode);
      addButton(toolbar, 'qaPlotReset', () => zoom(null));
      const hint = document.createElement('small');
      hint.textContent = t('qaPlotHelp');
      toolbar.append(hint);
      root.append(toolbar);
      if (set.size) activePlots = Object.keys(labels).filter(kind => set.has(kind)).map(kind => makePlot(kind, data));
      else {
        const note = document.createElement('p');
        note.className = 'panel qa-plot-empty';
        note.textContent = t('qaPlotChoose');
        root.append(note);
      }
      moveCursors(w.clock.current);
    }

    w.on('view', render);
    w.on('data', render);
    w.on('locale', render);
    w.on('theme', render);
    w.on('release', () => {
      viewport = null;
      Object.values(hiddenSeries).forEach(series => series.clear());
      destroy();
      root.remove();
    });
    w.clock.subscribe(moveCursors);
  });
})(globalThis);
