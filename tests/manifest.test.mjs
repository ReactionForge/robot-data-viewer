import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import '../manifest-worker.js';
import '../manifest.js';

const M = globalThis.RobotManifest;
function frame(index, sequence) {
  return {
    frame_index: index, nominal_pts_us: index * 33333, sensor_target_monotonic_ns: '1000000000000000000',
    camera_group_valid: true, sync_quality: { raw_span_ns: 500000, within_10ms: true, hardware_trigger_verified: true },
    cameras: { custom: { sequence, raw_ns: '1000000000000499500', pts_us: 1000000 + index * 33333, video_frame_index: index } },
    grippers: { umi_left: { valid: true, raw: 1, button_pressed: index === 0 }, umi_right: { valid: true } },
    imu: { accel_g: [0, 0, 1], gyro_dps: [0, 0, 0], valid: true },
    poses: {
      tracker_left: { pos: [1, 2, 3], rot_wxyz: [1, 0, 0, 0] },
      tracker_right: { matrix: [1, 0, 0, 4, 0, 1, 0, 5, 0, 0, 1, 6, 0, 0, 0, 1] }
    }
  };
}
async function analyze(rows, options = {}) {
  const worker = new Worker(
    'const { parentPort } = require("node:worker_threads");\n' +
    'globalThis.self = {postMessage: (value, transfers) => parentPort.postMessage(value, transfers)};\n' +
    globalThis.ManifestWorkerSource + '\nparentPort.on("message", data => self.onmessage({data}));', { eval: true }
  );
  try {
    const result = once(worker, 'message');
    worker.postMessage({ blob: new Blob(rows.map(row => (typeof row === 'string' ? row : JSON.stringify(row)) + '\r\n')),
      thresholds: M.defaults, ...options });
    return (await result)[0];
  } finally {
    await worker.terminate();
  }
}
test('worker transfers typed columns, normalized pose and byte-indexed raw JSON', async () => {
  const values = [frame(0, 4294967294), frame(1, 0), frame(2, 2), frame(3, 6), frame(4, 8)];
  values[3].cameras.custom.reason = '校验';
  const { summary, dataset } = await analyze([values[1], values[0], ...values.slice(2), '{bad']);
  assert.equal(summary.grade, 'WARN');
  assert.equal(summary.invalidLines, 1);
  assert.equal(summary.count.jumps, 1);
  assert.equal(dataset.expectedSeqStep.custom, 2);
  assert.deepEqual([...dataset.camDeltaSeq.custom.slice(1)], [2, 2, 4, 2]);
  assert.equal(dataset.camOffsetMs.custom[0], 0.4995);
  assert.equal(dataset.camPtsOrigin.custom, 1);
  assert.equal(dataset.camPtsSec.custom[3], 1.099999);
  assert.ok(dataset.frameAnomalyBitmask[0] & M.bits.BUTTON);
  assert.ok(dataset.frameAnomalyBitmask[3] & M.bits.SEQUENCE);
  assert.ok(dataset.timeSec instanceof Float64Array);
  assert.ok(dataset.camSeq.custom instanceof Int32Array);
  assert.ok(dataset.camSyntheticMask.custom instanceof Uint8Array);
  assert.ok(dataset.grippers.umi_left.angleDeg instanceof Float32Array);
  assert.ok(dataset.grippers.umi_left.raw instanceof Int32Array);
  assert.ok(dataset.imu.accelNorm instanceof Float32Array);
  assert.ok(dataset.frameAnomalyBitmask instanceof Uint32Array);
  assert.ok(dataset.timeline instanceof Uint8Array);
  assert.equal(dataset.timeline.length, 4 * summary.frames);
  assert.deepEqual([...dataset.buttonRanges.left], [0, 1]);
  assert.deepEqual([...dataset.pose.right.position.subarray(0, 3)], [4, 5, 6]);
  assert.deepEqual([...dataset.pose.left.quaternion.subarray(0, 4)], [0, 0, 0, 1]);
  assert.ok(dataset.imu.hasOrientation);
  assert.ok(dataset.imu.orientation.every(value => value === 0));
  const clock = M.clock();
  let index;
  clock.subscribe(frame => { index = frame.index; });
  clock.publish(dataset, .1, false, true);
  assert.equal(index, 3);
  assert.equal(clock.raw().cameras.custom.reason, '校验');
  clock.publish(dataset, .1, false, true, 2);
  assert.equal(clock.current.index, 2);
  clock.publish(dataset, .06, true, false);
  assert.equal(clock.current.index, 1);
  clock.publish(null, 0, false, true);
  assert.equal(clock.raw(), null);
});
test('summary-only worker applies critical thresholds and keeps sensor counters distinct', async () => {
  const values = [frame(0, 0), frame(1, 2), frame(2, 4)];
  values[1].sync_quality.raw_span_ns = 12e6;
  values[1].sync_quality.within_10ms = false;
  values[1].sync_quality.hardware_trigger_verified = false;
  values[1].poses = { tracker_left: null, tracker_right: null };
  values[2].grippers.umi_left.gap_exceeded = true;
  values[2].cameras.custom.synthetic = true;
  const { summary, dataset } = await analyze(values, { summaryOnly: true });
  assert.equal(dataset, undefined);
  assert.equal(summary.grade, 'FAIL');
  assert.equal(summary.hardware, false);
  assert.equal(summary.within10Rate, 2 / 3);
  assert.equal(summary.count.sensorGaps, 1);
  assert.equal(summary.count.poseLeft, 2);
  assert.equal(summary.count.synthetic, 1);
});
test('normal input passes and dt warning responds to threshold changes', async () => {
  const values = [frame(0, 1), frame(1, 3)];
  assert.equal((await analyze(values)).summary.grade, 'PASS');
  values[1].imu.dt_ns = 26e6;
  assert.equal((await analyze(values)).summary.grade, 'WARN');
  assert.equal((await analyze(values, { thresholds: { ...M.defaults, imuMs: 30 } })).summary.grade, 'PASS');
});
test('pose outage and trajectory never connect a lost segment', async () => {
  const values = Array.from({ length: 6 }, (_, i) => frame(i, i * 2));
  values[2].poses.tracker_left = null;
  values[3].poses.tracker_left.gap_exceeded = true;
  const { summary, dataset } = await analyze(values);
  assert.equal(summary.grade, 'FAIL');
  assert.equal(summary.count.sensorGaps, 1);
  assert.deepEqual(dataset.poseGaps.left, [{ from: 2, to: 3, start: .066666, end: .133332 }]);
  assert.equal(dataset.poseTrace.left.position.length, 12);
  assert.notEqual(M.annotationKey({ source: 'one', qa: summary }), M.annotationKey({ source: 'two', qa: summary }));
});
