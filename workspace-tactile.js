/* Tactile diff rendering is driven by the frame bus and each video's seek completion. */
(function (global) {
  'use strict';
  const $ = id => document.getElementById(id);
  const limit = 320;
  let turbo;
  Object.assign(global.ViewerStrings, {
    qaTactile: ['触觉增强', 'Tactile enhancement'], qaTactileRaw: ['原图', 'Original'],
    qaTactileDiff: ['基准差分', 'Baseline diff'], qaTactileHeat: ['伪彩热力', 'Turbo heatmap'],
    qaTactileBase: ['设当前帧为基准', 'Set current frame as baseline'], qaTactileGain: ['增益', 'Gain'],
    qaTactilePending: ['正在读取基准帧…', 'Reading baseline frames…'],
    qaTactileBaseline: ['基准 {time}', 'Baseline {time}'],
    qaTactileUnavailable: ['部分相机的基准帧不可用', 'Baseline frame unavailable for some cameras']
  });

  function palette() {
    if (turbo) return turbo;
    // Turbo polynomial by Anton Mikhailov and Ruofei Du, Google LLC, Apache-2.0.
    // https://gist.github.com/mikhailov-work/0d177465a8151eb6ede1768d51d476c7
    const coefficients = [
      [0.13572138, 4.6153926, -42.66032258, 132.13108234, -152.94239396, 59.28637943],
      [0.09140261, 2.19418839, 4.84296658, -14.18503333, 4.27729857, 2.82956604],
      [0.1066733, 12.64194608, -60.58204836, 110.36276771, -89.90310912, 27.34824973]
    ];
    turbo = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const x = i / 255;
      for (let channel = 0; channel < 3; channel++) {
        const [a, b, c, d, e, f] = coefficients[channel];
        turbo[i * 3 + channel] = 255 * (a + x * (b + x * (c + x * (d + x * (e + x * f)))));
      }
    }
    return turbo;
  }

  /** Wait for a decoded frame from a short-lived baseline-only video. */
  function mediaReady(video, name, check, signal) {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (check()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Baseline decode timed out')), 5000);
      const abort = () => finish(signal.reason);
      const error = () => finish(video.error || new Error('Baseline decode failed'));
      const ready = () => { if (check()) finish(); };
      function finish(reason) {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        video.removeEventListener('error', error);
        video.removeEventListener(name, ready);
        if (reason) reject(reason); else resolve();
      }
      signal.addEventListener('abort', abort, { once: true });
      video.addEventListener('error', error);
      video.addEventListener(name, ready);
      if (video.error) error();
    });
  }

  function pixels(video, canvas, context) {
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return context.getImageData(0, 0, canvas.width, canvas.height).data;
  }

  global.RobotWorkspace.use(w => {
    let mode = 'raw';
    let gain = 3;
    let baselineTime = 0;
    let baselineFrame = 0;
    let views = [];
    const bases = new Map();
    const jobs = new Map();
    const failed = new Set();
    const tools = $('tactileTools');
    const api = w.api;

    function status() {
      const enabled = mode !== 'raw';
      $('tactileBaseBtn').disabled = $('tactileGain').disabled = !enabled;
      $('tactileBaseStatus').textContent = !enabled ? '' : jobs.size ? api.t('qaTactilePending')
        : failed.size ? api.t('qaTactileUnavailable')
          : api.t('qaTactileBaseline', { time: api.timeText(baselineTime, 3) });
    }

    function clearBases() {
      for (const job of jobs.values()) job.abort();
      jobs.clear();
      bases.clear();
      failed.clear();
    }

    function removeViews() {
      for (const view of views) {
        view.video.removeEventListener('loadeddata', view.refresh);
        view.video.removeEventListener('seeked', view.refresh);
        view.overlay.remove();
        view.overlay.width = view.overlay.height = 0;
        view.scratch.width = view.scratch.height = 0;
        view.output = null;
      }
      views = [];
    }

    async function sample(view) {
      const key = view.channel.key;
      if (jobs.has(key) || failed.has(key) || bases.has(key)) return;
      const signaler = new AbortController();
      jobs.set(key, signaler);
      status();
      const media = document.createElement('video');
      media.muted = true;
      media.playsInline = true;
      media.preload = 'auto';
      const scratch = document.createElement('canvas');
      try {
        media.src = view.channel.url;
        await mediaReady(media, 'loadeddata', () => media.readyState >= 2, signaler.signal);
        const target = Math.min(Number.isFinite(media.duration) ? Math.max(0, media.duration - .002) : Infinity,
          Math.max(0, api.localTime(view.channel, baselineTime, baselineFrame)));
        if (Math.abs(media.currentTime - target) > .001) {
          media.currentTime = target;
          await mediaReady(media, 'seeked', () => !media.seeking && media.readyState >= 2, signaler.signal);
        }
        if (signaler.signal.aborted) return;
        const scale = Math.min(1, limit / Math.max(media.videoWidth, media.videoHeight));
        scratch.width = Math.max(1, Math.round(media.videoWidth * scale));
        scratch.height = Math.max(1, Math.round(media.videoHeight * scale));
        const context = scratch.getContext('2d', { willReadFrequently: true });
        bases.set(key, { width: scratch.width, height: scratch.height, pixels: pixels(media, scratch, context) });
        const stillVisible = views.find(item => item.channel.key === key);
        if (stillVisible) draw(stillVisible, true);
      } catch {
        if (!signaler.signal.aborted) failed.add(key);
      } finally {
        media.pause();
        media.removeAttribute('src');
        media.load();
        scratch.width = scratch.height = 0;
        if (jobs.get(key) === signaler) jobs.delete(key);
        status();
      }
    }

    function draw(view, exact) {
      const base = bases.get(view.channel.key);
      const video = view.video;
      if (!base || video.readyState < 2 || video.seeking || view.wrap.classList.contains('unavailable')) {
        view.overlay.hidden = true;
        return;
      }
      const decoded = video.getVideoPlaybackQuality?.().totalVideoFrames || video.currentTime;
      if (!exact && !view.overlay.hidden && view.lastFrame === decoded) return;
      view.lastFrame = decoded;
      if (!view.output) {
        view.overlay.width = view.scratch.width = base.width;
        view.overlay.height = view.scratch.height = base.height;
        view.output = view.context.createImageData(base.width, base.height);
      }
      try {
        const current = pixels(video, view.scratch, view.input);
        const output = view.output.data;
        const map = mode === 'heat' ? palette() : null;
        for (let i = 0; i < output.length; i += 4) {
          const intensity = Math.min(255, Math.round((Math.abs(current[i] - base.pixels[i]) +
            Math.abs(current[i + 1] - base.pixels[i + 1]) + Math.abs(current[i + 2] - base.pixels[i + 2])) * gain / 3));
          if (map) {
            const at = intensity * 3;
            output[i] = map[at];
            output[i + 1] = map[at + 1];
            output[i + 2] = map[at + 2];
          } else output[i] = output[i + 1] = output[i + 2] = intensity;
          output[i + 3] = 255;
        }
        view.context.putImageData(view.output, 0, 0);
        view.overlay.hidden = false;
      } catch { view.overlay.hidden = true; }
    }

    function resetViews() {
      removeViews();
      const session = api.session();
      tools.hidden = !session?.channels.some(channel => channel.group === 'tactile');
      if (mode === 'raw' || api.view() === 'analysis' || tools.hidden) { status(); return; }
      views = api.tiles().filter(tile => tile.channel.group === 'tactile').map(tile => {
        const overlay = document.createElement('canvas');
        overlay.className = 'tactile-overlay';
        overlay.hidden = true;
        const scratch = document.createElement('canvas');
        const view = { ...tile, overlay, scratch, input: scratch.getContext('2d', { willReadFrequently: true }),
          context: overlay.getContext('2d'), output: null, lastFrame: -1 };
        view.refresh = () => draw(view, true);
        tile.video.addEventListener('loadeddata', view.refresh);
        tile.video.addEventListener('seeked', view.refresh);
        tile.wrap.append(overlay);
        return view;
      });
      for (const view of views) {
        if (bases.has(view.channel.key)) draw(view, true);
        else sample(view);
      }
      status();
    }

    tools.querySelectorAll('[data-tactile]').forEach(button => button.addEventListener('click', () => {
      mode = button.dataset.tactile;
      tools.querySelectorAll('[data-tactile]').forEach(item => api.setPressed(item, item === button));
      if (mode === 'raw') clearBases();
      resetViews();
    }));
    $('tactileBaseBtn').addEventListener('click', () => {
      const current = w.clock.current;
      baselineTime = current.time;
      baselineFrame = current.index < 0 ? null : current.index;
      clearBases();
      resetViews();
    });
    $('tactileGain').addEventListener('input', event => {
      gain = Number(event.target.value);
      $('tactileGainValue').textContent = gain + '×';
      views.forEach(view => draw(view, true));
    });
    w.on('tiles', resetViews);
    w.on('view', resetViews);
    w.on('locale', status);
    w.on('release', () => {
      removeViews();
      clearBases();
      baselineTime = 0;
      baselineFrame = 0;
      status();
    });
    w.clock.subscribe(frame => {
      if (mode !== 'raw') for (const view of views) draw(view, frame.exact);
    });
  });
})(globalThis);
