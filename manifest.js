/* Manifest worker client, zero-copy episode data and imperative playback clock. */
(function (global) {
  'use strict';

  /**
   * @typedef {{angleDeg: Float32Array, angleSpeed: Float32Array, raw: Int32Array,
   * dtMs: Float32Array, alpha: Float32Array, buttonPressed: Uint8Array, flags: Uint8Array}} GripperColumns
   * @typedef {{ax: Float32Array, ay: Float32Array, az: Float32Array, gx: Float32Array, gy: Float32Array,
   * gz: Float32Array, accelNorm: Float32Array, dtMs: Float32Array, alpha: Float32Array, flags: Uint8Array,
   * orientation: Float32Array, hasOrientation: boolean}} ImuColumns
   * @typedef {{position: Float32Array, quaternion: Float32Array}} PoseColumns
   * @typedef {{position: Float32Array, angle: Float32Array, min: number[]|null, max: number[]|null,
   * angleMin: number|null, angleMax: number|null}} PoseTrace
   * @typedef {{from: number, to: number, start: number, end: number}} PoseOutage
   *
   * @typedef {object} ColumnarDataset
   * @property {string[]} cameraKeys
   * @property {Float64Array} timeSec Nominal media timestamps, in seconds.
   * @property {Int32Array} frameIndex Exporter frame numbers in playback order.
   * @property {Float64Array} rawSpanMs
   * @property {Record<string, Float64Array>} camOffsetMs
   * @property {Record<string, Float64Array>} camPtsSec
   * @property {Record<string, number>} camPtsOrigin Frame-zero media timestamp by camera, if known.
   * @property {Record<string, Int32Array>} camSeq
   * @property {Record<string, Int32Array>} camDeltaSeq
   * @property {Record<string, number|null>} expectedSeqStep
   * @property {Record<string, Uint8Array>} camSeqValid
   * @property {Record<string, Uint8Array>} camDeltaValid
   * @property {Record<string, Uint8Array>} camSyntheticMask
   * @property {Record<string, Uint8Array>} camJumpMask
   * @property {Record<'umi_left'|'umi_right', GripperColumns>} grippers
   * @property {ImuColumns} imu
   * @property {Record<'left'|'right', PoseColumns>} pose
   * @property {Record<'left'|'right', Uint8Array>} poseValidMask
   * @property {Record<'left'|'right', PoseTrace>} poseTrace
   * @property {Record<'left'|'right', PoseOutage[]>} poseGaps
   * @property {Record<'left'|'right', Uint32Array>} buttonRanges Start/end ordinal pairs.
   * @property {Uint32Array} notableFrames
   * @property {Uint8Array} timeline Four severity values per temporal bucket.
   * @property {Uint32Array} frameAnomalyBitmask
   * @property {{buffer: ArrayBuffer, start: Uint32Array|Float64Array, end: Uint32Array|Float64Array}} raw Byte index of the original JSONL.
   */
  const bits = Object.freeze({ SYNC_FAIL: 1, SYNC_WARN: 2, SYNTHETIC: 4, SEQUENCE: 8, CAMERA: 16,
    GRIPPER: 32, IMU: 64, POSE: 128, BUTTON: 256 });
  const sensorFlags = Object.freeze({ PRESENT: 1, VALID: 2, GAP: 4, INTERPOLATED: 8, ENCODER: 16, LATE: 32, INVALID: 64, RAW: 128 });
  const defaults = Object.freeze({ warnMs: 1, failMs: 10, gripperMs: 15, imuMs: 25, syntheticPct: 1 });
  const aliases = {
    third_view: 'ego.camera', ego_camera: 'ego.camera',
    left_wrist_view: 'left_umi.fisheye', right_wrist_view: 'right_umi.fisheye',
    left_wrist_left_tactile: 'left_umi.left_tactile', left_wrist_right_tactile: 'left_umi.right_tactile',
    right_wrist_left_tactile: 'right_umi.left_tactile', right_wrist_right_tactile: 'right_umi.right_tactile'
  };
  const decoder = new TextDecoder();

  function manifestEntry(entries) {
    const path = entry => entry.name.replace(/\\/g, '/');
    return entries.find(entry => /(?:^|\/)meta\/global_frame_manifest\.jsonl$/i.test(path(entry))) ||
      entries.find(entry => /(?:^|\/)global_frame_manifest\.jsonl$/i.test(path(entry))) || null;
  }

  function loadThresholds() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('rdv.qa.thresholds')) || {}; } catch {}
    const values = { ...defaults };
    for (const name in values) {
      if (Number.isFinite(saved[name]) && saved[name] > 0) values[name] = saved[name];
    }
    if (saved.syntheticPct === 0) values.syntheticPct = 0;
    if (values.warnMs > values.failMs) return { ...defaults };
    values.syntheticPct = Math.min(100, values.syntheticPct);
    return values;
  }

  /** Read and classify one episode in a disposable worker. The Blob stays file-backed during transfer. */
  function run(blob, { thresholds = loadThresholds(), summaryOnly = false, fps = 30, signal } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const url = URL.createObjectURL(new Blob([global.ManifestWorkerSource], { type: 'text/javascript' }));
      let worker;
      function finish() {
        signal?.removeEventListener('abort', abort);
        worker?.terminate();
        URL.revokeObjectURL(url);
      }
      function abort() { finish(); reject(signal.reason); }
      try { worker = new Worker(url, { name: 'robot-manifest' }); }
      catch (error) { finish(); reject(error); return; }
      signal?.addEventListener('abort', abort, { once: true });
      worker.onmessage = ({ data }) => {
        finish();
        if (data.error) reject(new Error(data.error));
        else resolve(data);
      };
      worker.onerror = event => {
        event.preventDefault();
        finish();
        reject(new Error(event.message || 'Manifest worker failed'));
      };
      worker.onmessageerror = () => { finish(); reject(new Error('Unable to transfer manifest columns')); };
      try { worker.postMessage({ blob, thresholds, summaryOnly, fps }); }
      catch (error) { finish(); reject(error); }
    });
  }

  function cameraKey(dataset, name) {
    if (!dataset) return null;
    const bare = name.replace(/^observation\.image\./i, '');
    const known = Object.hasOwn(aliases, bare) ? aliases[bare] : bare;
    if (dataset.cameraKeys.includes(name)) return name;
    return dataset.cameraKeys.find(key => key === bare || key === known ||
      key.replace(/^observation\.image\./i, '').replace(/[._-]/g, '').toLowerCase() === known.replace(/[._-]/g, '').toLowerCase()) ?? null;
  }

  function lowerBound(values, value) {
    let lo = 0;
    let hi = values.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (values[mid] < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** @param {ColumnarDataset} dataset @param {number} time Nominal timestamp, in seconds. */
  function nearest(dataset, time) {
    const values = dataset.timeSec;
    const next = lowerBound(values, time);
    if (next === 0 || next === values.length) return Math.min(next, values.length - 1);
    return time - values[next - 1] <= values[next] - time ? next - 1 : next;
  }

  function frameAtTime(dataset, time) {
    const values = dataset.timeSec;
    const next = lowerBound(values, time);
    return values[next] === time ? next : Math.max(0, next - 1);
  }

  const mediaTime = (data, index) => data.timeSec[index] - data.timeSec[0];
  const annotationKey = episode => (episode.identity || episode.source.replace(/\.tar$/i, '')) + ':' + episode.qa.key;

  function clock() {
    const subscribers = new Set();
    const event = { data: null, index: -1, time: 0, playing: false, exact: true };
    let lastData = null;
    let rawIndex = -1;
    let raw = null;
    return {
      get current() { return event; },
      publish(data, time, playing, exact, index) {
        if (lastData !== data) { lastData = data; rawIndex = -1; raw = null; }
        event.data = data;
        event.index = data ? (index ?? (playing ? frameAtTime : nearest)(data, time + data.timeSec[0])) : -1;
        event.time = time;
        event.playing = playing;
        event.exact = exact;
        for (const listener of subscribers) listener(event);
      },
      subscribe(listener) {
        subscribers.add(listener);
        return () => subscribers.delete(listener);
      },
      raw(index = event.index) {
        if (!event.data || index < 0 || index >= event.data.timeSec.length) return null;
        if (index !== rawIndex) {
          const { buffer, start, end } = event.data.raw;
          raw = JSON.parse(decoder.decode(new Uint8Array(buffer, start[index], end[index] - start[index])));
          rawIndex = index;
        }
        return raw;
      }
    };
  }

  global.RobotManifest = { bits, sensorFlags, defaults, loadThresholds, manifestEntry, run, cameraKey, lowerBound, nearest, mediaTime, annotationKey, clock };
})(globalThis);
