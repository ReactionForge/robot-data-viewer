/* Worker code is self-contained so the offline viewer can run it from a Blob URL. */
(function (global) {
  'use strict';

  function workerMain() {
    const B = { SYNC_FAIL: 1, SYNC_WARN: 2, SYNTHETIC: 4, SEQUENCE: 8, CAMERA: 16, GRIPPER: 32, IMU: 64, POSE: 128, BUTTON: 256 };
    const S = { PRESENT: 1, VALID: 2, GAP: 4, INTERPOLATED: 8, ENCODER: 16, LATE: 32, INVALID: 64, RAW: 128 };
    const emptyInt = -2147483648;
    const finite = value => {
      if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return NaN;
      const number = Number(value);
      return Number.isFinite(number) ? number : NaN;
    };
    const float64 = n => new Float64Array(n).fill(NaN);
    const float32 = n => new Float32Array(n).fill(NaN);
    const ints = n => new Int32Array(n).fill(emptyInt);
    const bytes = n => new Uint8Array(n);
    const own = () => Object.create(null);

    function nsDiff(a, b) {
      if ((typeof a === 'string' || typeof b === 'string') && /^-?\d+$/.test(String(a)) && /^-?\d+$/.test(String(b))) {
        return Number(BigInt(a) - BigInt(b));
      }
      return finite(a) - finite(b);
    }

    function vector(value, names) {
      if (value == null) return null;
      const list = Array.isArray(value) ? value : names.map(name => value[name]);
      if (list.length !== names.length) return null;
      const result = list.map(finite);
      return result.every(Number.isFinite) ? result : null;
    }

    function poseParts(value) {
      if (!value || value.valid === false || value.gap_exceeded === true) return null;
      const matrixSource = Array.isArray(value) ? value : value.matrix ?? value.matrix4x4 ?? value.matrix_4x4 ?? value.transform ?? value.T;
      const flat = Array.isArray(matrixSource) && matrixSource.length === 4 ? matrixSource.flat() : matrixSource;
      let matrix = Array.isArray(flat) && flat.length === 16 ? flat.map(finite) : null;
      if (matrix && !matrix.every(Number.isFinite)) matrix = null;
      if (matrix) {
        const lastColumn = Math.hypot(matrix[3], matrix[7], matrix[11]);
        const lastRow = Math.hypot(matrix[12], matrix[13], matrix[14]);
        const columnMajor = value.matrix_order === 'column_major' || (lastColumn < 1e-8 && lastRow >= 1e-8);
        if (columnMajor) matrix = matrix.map((_, i) => matrix[(i % 4) * 4 + Math.floor(i / 4)]);
      }
      let pos = vector(value.pos ?? value.position ?? value.translation, ['x', 'y', 'z']);
      let quat = vector(value.quaternion ?? value.rot_xyzw ?? value.quat ?? value.orientation, ['x', 'y', 'z', 'w']);
      const wxyz = vector(value.rot_wxyz ?? value.quat_wxyz, ['w', 'x', 'y', 'z']);
      if (!quat && wxyz) quat = [wxyz[1], wxyz[2], wxyz[3], wxyz[0]];
      if (matrix) {
        pos ??= [matrix[3], matrix[7], matrix[11]];
        if (!quat) {
          const a = matrix;
          const trace = a[0] + a[5] + a[10];
          if (trace > 0) {
            const scale = 2 * Math.sqrt(trace + 1);
            quat = [(a[9] - a[6]) / scale, (a[2] - a[8]) / scale, (a[4] - a[1]) / scale, scale / 4];
          } else {
            const k = a[0] > a[5] && a[0] > a[10] ? 0 : a[5] > a[10] ? 1 : 2;
            const next = (k + 1) % 3;
            const last = (k + 2) % 3;
            const scale = 2 * Math.sqrt(Math.max(0, 1 + a[k * 5] - a[next * 5] - a[last * 5]));
            if (scale) {
              quat = [0, 0, 0, 0];
              quat[k] = scale / 4;
              quat[next] = (a[k * 4 + next] + a[next * 4 + k]) / scale;
              quat[last] = (a[k * 4 + last] + a[last * 4 + k]) / scale;
              quat[3] = (a[last * 4 + next] - a[next * 4 + last]) / scale;
            }
          }
        }
      }
      if (!pos) return null;
      const length = quat && Math.hypot(...quat);
      return { pos, quat: length > 0 ? quat.map(component => component / length) : null };
    }

    function flags(value, dt, limit, raw) {
      if (!value || typeof value !== 'object') return 0;
      const invalid = value.valid === false || value.encoder_valid === false;
      return S.PRESENT | (invalid ? S.INVALID : S.VALID) | (value.gap_exceeded === true ? S.GAP : 0) |
        (value.interpolated === true ? S.INTERPOLATED : 0) | (value.encoder_valid === false ? S.ENCODER : 0) |
        (dt > limit ? S.LATE : 0) | (raw ? S.RAW : 0);
    }

    function increments(mode) {
      let step = null;
      let frequency = 0;
      for (const [delta, count] of mode) {
        const tie = count === frequency && (step === null || (delta > 0 && step <= 0) ||
          ((delta > 0) === (step > 0) && Math.abs(delta) < Math.abs(step)));
        if (count > frequency || tie) { frequency = count; step = delta; }
      }
      return step;
    }

    function quantile(ordered, q) {
      if (!ordered.length) return null;
      const location = (ordered.length - 1) * q;
      const floor = Math.floor(location);
      return ordered[floor] + (ordered[Math.ceil(location)] - ordered[floor]) * (location - floor);
    }

    function gapRanges(mask, times, duration) {
      const ranges = [];
      for (let index = 0; index < mask.length;) {
        if (mask[index]) { index++; continue; }
        const from = index;
        while (index < mask.length && !mask[index]) index++;
        ranges.push({ from, to: index - 1, start: times[from] - times[0], end: index < mask.length ? times[index] - times[0] : duration });
      }
      return ranges;
    }

    function trajectory(mask, position, gripper) {
      const trace = [], angles = [];
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      const stride = Math.max(1, Math.ceil(mask.length / 5500));
      let previous = -1;
      let angleMin = Infinity;
      let angleMax = -Infinity;
      function vertex(index) {
        trace.push(position[index * 3], position[index * 3 + 1], position[index * 3 + 2]);
        angles.push(gripper.angleDeg[index]);
      }
      for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) { previous = -1; continue; }
        for (let axis = 0; axis < 3; axis++) {
          min[axis] = Math.min(min[axis], position[i * 3 + axis]);
          max[axis] = Math.max(max[axis], position[i * 3 + axis]);
        }
        if (Number.isFinite(gripper.angleDeg[i])) {
          angleMin = Math.min(angleMin, gripper.angleDeg[i]);
          angleMax = Math.max(angleMax, gripper.angleDeg[i]);
        }
        if (previous < 0) previous = i;
        else if (i - previous >= stride || !mask[i + 1]) {
          vertex(previous);
          vertex(i);
          previous = i;
        }
      }
      return {
        position: Float32Array.from(trace), angle: Float32Array.from(angles),
        min: Number.isFinite(min[0]) ? min : null, max: Number.isFinite(max[0]) ? max : null,
        angleMin: Number.isFinite(angleMin) ? angleMin : null, angleMax: Number.isFinite(angleMax) ? angleMax : null
      };
    }

    function imuAttitude(imu, times) {
      const orientation = float32(times.length * 3);
      const scale = Math.PI / 180;
      const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
      let roll = 0, pitch = 0, yaw = 0, initialized = false;
      for (let i = 0; i < times.length; i++) {
        if (!(imu.flags[i] & S.VALID) || imu.flags[i] & S.GAP) continue;
        const dt = i ? Math.max(0, Math.min(0.25, times[i] - times[i - 1])) : 0;
        const goodAccel = imu.accelNorm[i] >= .5 && imu.accelNorm[i] <= 1.6;
        if (Number.isFinite(imu.gx[i])) {
          roll = wrap(roll + imu.gx[i] * scale * dt);
          pitch = wrap(pitch + imu.gy[i] * scale * dt);
          yaw = wrap(yaw + imu.gz[i] * scale * dt);
        }
        if (goodAccel) {
          const tiltRoll = Math.atan2(imu.ay[i], imu.az[i]);
          const tiltPitch = Math.atan2(-imu.ax[i], Math.hypot(imu.ay[i], imu.az[i]));
          const blend = initialized ? 1 - Math.exp(-dt / .45) : 1;
          roll = wrap(roll + blend * wrap(tiltRoll - roll));
          pitch = wrap(pitch + blend * wrap(tiltPitch - pitch));
        }
        if (!goodAccel && !Number.isFinite(imu.gx[i])) continue;
        initialized = true;
        orientation[i * 3] = roll;
        orientation[i * 3 + 1] = pitch;
        orientation[i * 3 + 2] = yaw;
      }
      return orientation;
    }

    async function analyze(blob, thresholds, summaryOnly, fallbackFps) {
      const buffer = await blob.arrayBuffer();
      const data = new Uint8Array(buffer);
      const decoder = new TextDecoder();
      const parse = (start, end) => JSON.parse(decoder.decode(data.subarray(start, end)));
      const rows = [];
      const keys = new Set();
      let invalidLines = 0;
      let index = 0;
      while (index < data.length) {
        const start = index;
        let end = data.indexOf(10, start);
        if (end === -1) end = data.length;
        index = end + 1;
        let blank = true;
        for (let cursor = start; cursor < end; cursor++) {
          if (data[cursor] > 32) { blank = false; break; }
        }
        if (blank) continue;
        try {
          const row = parse(start, end);
          if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Expected frame object');
          const pts = finite(row.nominal_pts_us);
          const frame = finite(row.frame_index);
          const value = Number.isFinite(pts) ? pts / 1e6 : (Number.isInteger(frame) ? frame : rows.length) / fallbackFps;
          rows.push([start, end, value, Number.isInteger(frame) ? frame : rows.length]);
          if (row.cameras && typeof row.cameras === 'object') Object.keys(row.cameras).forEach(key => keys.add(key));
        } catch { invalidLines++; }
      }
      if (!rows.length) throw new Error('Manifest contains no readable frame records');
      if (rows.some((row, i) => i > 0 && row[2] < rows[i - 1][2])) rows.sort((a, b) => a[2] - b[2]);
      const n = rows.length;
      const cameraKeys = [...keys];
      const timeSec = float64(n);
      const frameIndex = ints(n);
      const ByteIndex = blob.size > 0xffffffff ? Float64Array : Uint32Array;
      const rawStart = new ByteIndex(n);
      const rawEnd = new ByteIndex(n);
      const rawSpanMs = float64(n);
      const camOffsetMs = own(), camSeq = own(), camDeltaSeq = own(), expectedSeqStep = own();
      const camPtsSec = own(), camPtsOrigin = own();
      const camSyntheticMask = own(), camSeqValid = own(), camDeltaValid = own(), camJumpMask = own(), modes = own();
      for (const key of cameraKeys) {
        camOffsetMs[key] = float64(n);
        camPtsSec[key] = float64(n);
        camPtsOrigin[key] = 0;
        camSeq[key] = ints(n);
        camDeltaSeq[key] = ints(n);
        camSyntheticMask[key] = bytes(n);
        camSeqValid[key] = bytes(n);
        camDeltaValid[key] = bytes(n);
        camJumpMask[key] = bytes(n);
        modes[key] = new Map();
      }
      const grippers = own();
      for (const key of ['umi_left', 'umi_right']) {
        grippers[key] = { angleDeg: float32(n), angleSpeed: float32(n), raw: ints(n), dtMs: float32(n),
          alpha: float32(n), buttonPressed: bytes(n), flags: bytes(n) };
      }
      const imu = { ax: float32(n), ay: float32(n), az: float32(n), gx: float32(n), gy: float32(n), gz: float32(n),
        accelNorm: float32(n), dtMs: float32(n), alpha: float32(n), flags: bytes(n) };
      const poseValidMask = { left: bytes(n), right: bytes(n) };
      const pose = {
        left: { position: float32(n * 3), quaternion: float32(n * 4) },
        right: { position: float32(n * 3), quaternion: float32(n * 4) }
      };
      const frameAnomalyBitmask = new Uint32Array(n);
      const knownSync = bytes(n);
      const spans = [];
      const count = { syncFail: 0, syncWarn: 0, valid10: 0, known10: 0, synthetic: 0, syntheticFrames: 0, jumps: 0, jumpFrames: 0,
        cameraInvalid: 0, sensorGaps: 0, sensorWarnings: 0, poseLeft: 0, poseRight: 0, poseMissing: 0,
        hardwareFalse: 0, hardwareTrue: 0, buttonEdges: 0 };
      for (let i = 0; i < n; i++) {
        const [start, end, time, frame] = rows[i];
        const row = parse(start, end);
        timeSec[i] = time;
        frameIndex[i] = frame;
        rawStart[i] = start;
        rawEnd[i] = end;
        let mask = 0;
        const quality = row.sync_quality || {};
        const span = finite(quality.raw_span_ns) / 1e6;
        rawSpanMs[i] = span;
        if (Number.isFinite(span)) spans.push(span);
        const within10 = typeof quality.within_10ms === 'boolean' ? quality.within_10ms
          : Number.isFinite(span) ? span <= 10 : null;
        if (within10 !== null) { knownSync[i] = 1; count.known10++; if (within10) count.valid10++; }
        if (span > thresholds.failMs || quality.within_10ms === false) { mask |= B.SYNC_FAIL; count.syncFail++; }
        if (span > thresholds.warnMs || quality.within_1ms === false || (mask & B.SYNC_FAIL)) {
          mask |= B.SYNC_WARN;
          if (!(mask & B.SYNC_FAIL)) count.syncWarn++;
        }
        if (quality.hardware_trigger_verified === false) count.hardwareFalse++;
        if (quality.hardware_trigger_verified === true) count.hardwareTrue++;
        if (row.camera_group_valid === false) { mask |= B.CAMERA; count.cameraInvalid++; }
        for (const key of cameraKeys) {
          const cam = row.cameras?.[key];
          if (!cam) continue;
          camOffsetMs[key][i] = nsDiff(cam.raw_ns, row.sensor_target_monotonic_ns) / 1e6;
          const pts = finite(cam.pts_us) / 1e6;
          camPtsSec[key][i] = pts;
          if (Number.isFinite(pts) && finite(cam.video_frame_index) === 0) camPtsOrigin[key] = pts;
          const seq = finite(cam.sequence);
          if (Number.isInteger(seq) && seq >= 0 && seq <= 0xffffffff) {
            camSeq[key][i] = seq;
            camSeqValid[key][i] = 1;
            if (i && camSeqValid[key][i - 1]) {
              const previous = camSeq[key][i - 1] >>> 0;
              const delta = (seq - previous) | 0;
              camDeltaSeq[key][i] = delta;
              camDeltaValid[key][i] = 1;
              if (delta) modes[key].set(delta, 1 + (modes[key].get(delta) || 0));
            }
          }
          if (cam.synthetic === true) { camSyntheticMask[key][i] = 1; mask |= B.SYNTHETIC; count.synthetic++; }
        }
        if (mask & B.SYNTHETIC) count.syntheticFrames++;
        for (const key of ['umi_left', 'umi_right']) {
          const grip = row.grippers?.[key];
          const column = grippers[key];
          const dt = finite(grip?.dt_ns) / 1e6;
          const raw = finite(grip?.raw);
          const validRaw = Number.isInteger(raw) && raw >= emptyInt && raw <= 0x7fffffff;
          column.angleDeg[i] = finite(grip?.angle_deg);
          if (validRaw) column.raw[i] = raw;
          column.dtMs[i] = dt;
          column.alpha[i] = finite(grip?.alpha);
          column.flags[i] = flags(grip, dt, thresholds.gripperMs, validRaw);
          if (i && time > timeSec[i - 1] && (column.flags[i] & S.VALID) && (column.flags[i - 1] & S.VALID) &&
              !((column.flags[i] | column.flags[i - 1]) & S.GAP)) {
            column.angleSpeed[i] = (column.angleDeg[i] - column.angleDeg[i - 1]) / (time - timeSec[i - 1]);
          }
          column.buttonPressed[i] = grip?.button_pressed === true ? 1 : 0;
          if ((i ? column.buttonPressed[i - 1] : 0) !== column.buttonPressed[i]) mask |= B.BUTTON;
          if (column.flags[i] & S.GAP) count.sensorGaps++;
          if (!grip || column.flags[i] & (S.GAP | S.INVALID | S.LATE)) { mask |= B.GRIPPER; count.sensorWarnings++; }
        }
        const unit = row.imu;
        const accel = vector(unit?.accel_g, ['x', 'y', 'z']);
        const gyro = vector(unit?.gyro_dps, ['x', 'y', 'z']);
        if (accel) {
          [imu.ax[i], imu.ay[i], imu.az[i]] = accel;
          imu.accelNorm[i] = Math.hypot(...accel);
        }
        if (gyro) [imu.gx[i], imu.gy[i], imu.gz[i]] = gyro;
        imu.dtMs[i] = finite(unit?.dt_ns) / 1e6;
        imu.alpha[i] = finite(unit?.alpha);
        imu.flags[i] = flags(unit, imu.dtMs[i], thresholds.imuMs, false);
        if (imu.flags[i] & S.GAP) count.sensorGaps++;
        if (!unit || imu.flags[i] & (S.GAP | S.INVALID | S.LATE)) { mask |= B.IMU; count.sensorWarnings++; }
        for (const side of ['left', 'right']) {
          const payload = row.poses?.['tracker_' + side];
          if (payload?.gap_exceeded === true) count.sensorGaps++;
          const reading = poseParts(payload);
          if (!reading) continue;
          poseValidMask[side][i] = 1;
          pose[side].position.set(reading.pos, i * 3);
          if (reading.quat) pose[side].quaternion.set(reading.quat, i * 4);
          count[side === 'left' ? 'poseLeft' : 'poseRight']++;
        }
        if (!poseValidMask.left[i] || !poseValidMask.right[i]) { mask |= B.POSE; count.poseMissing++; }
        if (mask & B.BUTTON) count.buttonEdges++;
        frameAnomalyBitmask[i] = mask;
      }
      for (const key of cameraKeys) {
        const step = increments(modes[key]);
        expectedSeqStep[key] = step;
        if (step === null) continue;
        for (let i = 1; i < n; i++) {
          if (camDeltaValid[key][i] && camDeltaSeq[key][i] !== step && frameIndex[i] > 0) {
            camJumpMask[key][i] = 1;
            frameAnomalyBitmask[i] |= B.SEQUENCE;
            count.jumps++;
          }
        }
      }
      for (const mask of frameAnomalyBitmask) if (mask & B.SEQUENCE) count.jumpFrames++;
      const elapsed = timeSec[n - 1] - timeSec[0];
      const fps = n > 1 && elapsed > 0 ? (n - 1) / elapsed : null;
      const duration = elapsed + 1 / (fps || fallbackFps);
      const syntheticPct = 100 * count.syntheticFrames / n;
      const hardware = count.hardwareFalse ? false : count.hardwareTrue ? true : null;
      spans.sort((a, b) => a - b);
      const issues = [
        ['syncFail', count.syncFail], ['cameraInvalid', count.cameraInvalid], ['sensorGaps', count.sensorGaps],
        ['synthetic', count.syntheticFrames], ['sequence', count.jumpFrames], ['pose', count.poseMissing],
        ['hardware', count.hardwareFalse], ['syncWarn', count.syncWarn], ['sensorWarnings', count.sensorWarnings],
        ['incomplete', invalidLines + n - count.known10 + (hardware === null ? 1 : 0)]
      ].filter(([, total]) => total > 0);
      const grade = count.syncFail || count.cameraInvalid || count.sensorGaps || syntheticPct > thresholds.syntheticPct
        ? 'FAIL' : issues.length ? 'WARN' : 'PASS';
      let hash = 2166136261;
      for (let i = 0; i < data.length; i++) {
        hash = Math.imul(hash ^ data[i], 16777619);
      }
      const summary = {
        frames: n, duration, fps, cameraCount: cameraKeys.length,
        maxSpanMs: spans.at(-1) ?? null, p95SpanMs: quantile(spans, .95),
        within10Rate: count.known10 ? count.valid10 / count.known10 : null, hardware, grade, syntheticPct, count, issues,
        invalidLines, key: (hash >>> 0).toString(36) + '-' + blob.size.toString(36)
      };
      if (summaryOnly) return { summary };
      imu.orientation = imuAttitude(imu, timeSec);
      imu.hasOrientation = imu.orientation.some(Number.isFinite);
      const columns = Math.min(n, 4096);
      const timeline = new Uint8Array(columns * 4);
      const notableFrames = [];
      const buttons = { left: [], right: [] };
      const pressedAt = { left: -1, right: -1 };
      const strictSensor = flag => (flag & (S.GAP | S.INVALID)) !== 0;
      for (let i = 0; i < n; i++) {
        const pixel = Math.min(columns - 1, Math.floor((timeSec[i] - timeSec[0]) / duration * columns)) * 4;
        const mask = frameAnomalyBitmask[i];
        if (mask & (B.SYNC_FAIL | B.SYNTHETIC | B.SEQUENCE | B.CAMERA | B.GRIPPER | B.IMU | B.BUTTON)) notableFrames.push(i);
        const left = grippers.umi_left;
        const right = grippers.umi_right;
        for (const [side, pressed] of [['left', left.buttonPressed[i]], ['right', right.buttonPressed[i]]]) {
          if (pressed && pressedAt[side] < 0) pressedAt[side] = i;
          if (pressedAt[side] >= 0 && (!pressed || i === n - 1)) {
            buttons[side].push(pressedAt[side], pressed ? n : i);
            pressedAt[side] = -1;
          }
        }
        const severity = mask & B.SYNC_FAIL ? 3 : mask & B.SYNC_WARN ? 2 : knownSync[i] ? 1 : 0;
        timeline[pixel] = Math.max(timeline[pixel], severity);
        timeline[pixel + 1] = Math.max(timeline[pixel + 1], mask & B.SYNTHETIC ? 3 : mask & B.SEQUENCE ? 2 : mask & B.CAMERA ? 1 : 0);
        timeline[pixel + 2] |= left.buttonPressed[i] | (right.buttonPressed[i] << 1);
        const sensor = strictSensor(left.flags[i]) || strictSensor(right.flags[i]) || strictSensor(imu.flags[i]) ? 3
          : mask & (B.GRIPPER | B.IMU) ? 2 : mask & B.POSE ? 1 : 0;
        timeline[pixel + 3] = Math.max(timeline[pixel + 3], sensor);
      }
      return {
        summary, dataset: {
          cameraKeys, timeSec, frameIndex, rawSpanMs, camOffsetMs, camPtsSec, camPtsOrigin, camSeq, camDeltaSeq, expectedSeqStep,
          camSyntheticMask, camSeqValid, camDeltaValid, camJumpMask, grippers, imu, pose, poseValidMask,
          poseTrace: {
            left: trajectory(poseValidMask.left, pose.left.position, grippers.umi_left),
            right: trajectory(poseValidMask.right, pose.right.position, grippers.umi_right)
          },
          poseGaps: { left: gapRanges(poseValidMask.left, timeSec, duration), right: gapRanges(poseValidMask.right, timeSec, duration) },
          timeline, frameAnomalyBitmask, notableFrames: Uint32Array.from(notableFrames),
          buttonRanges: { left: Uint32Array.from(buttons.left), right: Uint32Array.from(buttons.right) },
          raw: { buffer, start: rawStart, end: rawEnd }
        }
      };
    }

    function transfers(result) {
      const found = new Set();
      function visit(value) {
        if (ArrayBuffer.isView(value)) found.add(value.buffer);
        else if (value instanceof ArrayBuffer) found.add(value);
        else if (value && typeof value === 'object') Object.values(value).forEach(visit);
      }
      visit(result);
      return [...found];
    }

    self.onmessage = async ({ data }) => {
      try {
        const result = await analyze(data.blob, data.thresholds, data.summaryOnly, data.fps || 30);
        self.postMessage(result, transfers(result));
      } catch (error) {
        self.postMessage({ error: error.message || String(error) });
      }
    };
  }

  global.ManifestWorkerSource = '(' + workerMain.toString() + ')();';
})(globalThis);
