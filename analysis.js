/* Timestamp and CSV analysis shared by TAR and folder imports. */
(function (global) {
  'use strict';

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let index = text.charCodeAt(0) === 0xfeff ? 1 : 0; index < text.length; index++) {
      const char = text[index];
      if (char === '"' && quoted && text[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"' && (quoted || !field)) {
        quoted = !quoted;
      } else if (!quoted && (char === ',' || char === '\n' || char === '\r')) {
        row.push(field.trim());
        field = '';
        if (char !== ',') {
          if (row.some(Boolean)) rows.push(row);
          row = [];
          if (char === '\r' && text[index + 1] === '\n') index++;
        }
      } else {
        field += char;
      }
    }
    if (quoted) throw new Error('Unclosed CSV field');
    row.push(field.trim());
    if (row.some(Boolean)) rows.push(row);
    return rows;
  }

  const numeric = value => value != null && value.trim() !== '' && Number.isFinite(Number(value))
    ? Number(value) : null;
  const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
  const columnKey = header => header.toLowerCase().replace(/[\s-]+/g, '_');

  function timeColumn(headers) {
    const names = headers.map(columnKey);
    const find = pattern => names.findIndex(name => pattern.test(name));
    let index = find(/^(?:(?:capture_|monotonic_|unix_)?timestamp|time|t|elapsed|relative_time)(?:_(?:ms|us|µs|μs|ns|s|sec|seconds))?$/);
    if (index !== -1) return { index, name: names[index] };
    index = find(/^(?:frame(?:_?(?:index|idx|id|number|no))?|index)$/);
    return index === -1 ? null : { index, frame: true };
  }

  function timeReader(column, fps, sessionClock = false) {
    if (column.frame) {
      return value => {
        const number = numeric(value);
        return number === null || number < 0 || !Number.isInteger(number) || !fps
          ? null : { ms: 1000 * number / fps, clock: 'frame' };
      };
    }
    const name = column.name;
    const suffix = name.match(/_(ms|us|µs|μs|ns|s|sec|seconds)$/)?.[1];
    const scale = { ms: 1, us: 0.001, 'µs': 0.001, 'μs': 0.001, ns: 0.000001, s: 1000, sec: 1000, seconds: 1000 };
    return value => {
      const number = numeric(value);
      if (number === null) {
        if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value || '')) return null;
        const ms = Date.parse(value);
        return Number.isFinite(ms) ? { ms, clock: 'epoch' } : null;
      }
      const magnitude = Math.abs(number);
      let factor = scale[suffix];
      if (!factor) factor = magnitude >= 1e17 ? 1e-6 : magnitude >= 1e14 ? 1e-3 : magnitude >= 1e11 ? 1 : 1000;
      const ms = number * factor;
      if (!Number.isFinite(ms)) return null;
      const relative = /^(elapsed|relative_time)/.test(name) || name === 't' || name.startsWith('t_');
      const clock = relative ? 'relative' : ms >= 946684800000 && ms < 4102444800000
        ? 'epoch' : sessionClock && name === 'timestamp_ms' ? 'session'
          : name.includes('timestamp') ? 'capture' : 'relative';
      if (clock === 'session' && ms < 0) return null;
      return { ms, clock };
    };
  }

  function quantile(sorted, q) {
    if (!sorted.length) return null;
    const position = (sorted.length - 1) * q;
    const index = Math.floor(position);
    return sorted[index] + (sorted[Math.ceil(position)] - sorted[index]) * (position - index);
  }

  function inspectTiming(rows, readTime, nominal, legacyMs = false) {
    const points = [];
    const forward = [];
    let first = null;
    let clock = null;
    let previous = null;
    let end = null;
    let valid = 0;
    let invalid = 0;
    let duplicates = 0;
    let reversed = 0;
    for (const row of rows) {
      const stamp = readTime(row);
      if (!stamp || (clock !== null && stamp.clock !== clock)) {
        invalid++;
        continue;
      }
      const ms = stamp.ms;
      if (first === null) {
        first = ms;
        clock = stamp.clock;
      }
      valid++;
      end = end === null ? ms : Math.max(end, ms);
      if (previous !== null && Number.isFinite(ms - previous)) {
        const interval = ms - previous;
        points.push([ms, interval]);
        if (interval > 0) forward.push(interval);
        else if (interval === 0) duplicates++;
        else reversed++;
      }
      previous = ms;
    }
    const sorted = forward.slice().sort((a, b) => a - b);
    const median = quantile(sorted, 0.5);
    const expected = nominal ? 1000 / nominal : median;
    const gaps = expected ? forward.filter(interval => interval > expected * 1.5).length : null;
    points.sort((a, b) => a[0] - b[0]);
    return {
      first, clock, end, points, valid, invalid, duplicates, reversed, median, expected, gaps, legacyMs,
      p95: quantile(sorted, 0.95), max: sorted.at(-1) ?? null,
      hz: median ? 1000 / median : null
    };
  }

  function readTiming(text, nominal, schema = null) {
    const [headers = [], ...rows] = parseCsv(text);
    const column = timeColumn(headers);
    if (!column || column.frame) return { table: { headers, rows }, timing: null };
    // Some older device exports used timestamp_ms for nanosecond readings.
    // Only repair this when the deltas are impossible as milliseconds and
    // consistent with video frame intervals after converting from nanoseconds.
    const sample = rows.slice(0, 120).map(row => numeric(row[column.index])).filter(value => value !== null);
    const deltas = sample.slice(1).map((value, index) => value - sample[index]).filter(value => value > 0);
    const median = quantile(deltas.sort((a, b) => a - b), 0.5);
    const expected = nominal ? 1000 / nominal : null;
    const legacyMs = !schema && column.name === 'timestamp_ms' && deltas.length >= 3 && median >= 1e6
      && (expected ? Math.abs(median / 1e6 / expected - 1) < 0.5 : median >= 4e6 && median <= 250e6);
    const reader = timeReader(legacyMs ? { ...column, name: 'timestamp_ns' } : column, null, !!schema);
    const table = { headers, rows };
    if (legacyMs) table.column = { ...column, name: 'timestamp_ns' };
    const timing = inspectTiming(rows, row => reader(row[column.index]), nominal, legacyMs);
    const flag = schema ? headers.findIndex(header => columnKey(header) === 'is_new') : -1;
    if (flag !== -1) {
      timing.flags = { captured: 0, synthetic: 0, dropped: 0, unknown: 0 };
      for (const row of rows) {
        const disposition = /^[012]$/.test(row[flag] || '') ? ['dropped', 'captured', 'synthetic'][Number(row[flag])] : null;
        timing.flags[disposition || 'unknown']++;
      }
    }
    return { table, timing };
  }

  function readSignals(table, name, fps, clock, origin, sessionClock = false, relativeStart = 0) {
    const { headers, rows } = table;
    const column = table.column || timeColumn(headers);
    if (!column) return [];
    const reader = timeReader(column, fps, sessionClock);
    const sourceIndex = headers.findIndex(header => columnKey(header) === 'source_id');
    const columns = headers.map((label, index) => ({ label, index }))
      .filter(({ label, index }) => label && index !== column.index && index !== sourceIndex &&
        !/^(?:index|is_new|host_timestamp_ns|frame(?:_?(?:index|idx|id|number|no))?)$/.test(columnKey(label)));
    const groups = new Map();
    for (const row of rows) {
      const stamp = reader(row[column.index]);
      if (!stamp) continue;
      const source = row[sourceIndex] || '';
      let group = groups.get(source);
      if (!group) {
        const anchored = stamp.clock === 'session' || (origin !== null && stamp.clock === clock);
        const base = stamp.clock === 'session' || stamp.clock === 'frame' ? 0 : anchored ? origin : stamp.ms;
        group = {
          base, anchored, clock: stamp.clock,
          signals: columns.map(column => ({ ...column, points: [], min: Infinity, max: -Infinity, mean: 0 }))
        };
        groups.set(source, group);
      }
      if (stamp.clock !== group.clock) continue;
      const seconds = (stamp.ms - group.base) / 1000 + (group.anchored ? 0 : relativeStart);
      if (!Number.isFinite(seconds)) continue;
      for (const signal of group.signals) {
        const value = numeric(row[signal.index]);
        if (value === null) continue;
        signal.points.push([seconds, value]);
        signal.min = Math.min(signal.min, value);
        signal.max = Math.max(signal.max, value);
        const count = signal.points.length;
        signal.mean = signal.mean * ((count - 1) / count) + value / count;
      }
    }
    return [...groups].flatMap(([source, group]) => group.signals.filter(signal => signal.points.length).map(signal => {
      signal.points.sort((a, b) => a[0] - b[0]);
      return { ...signal, name, source, clock: group.clock, anchored: group.anchored };
    }));
  }

  function alignChannels(channels) {
    const measured = channels.filter(channel => channel.timing?.first != null);
    const groups = ['session', 'epoch', 'capture'].map(clock => ({
      clock, channels: measured.filter(channel => channel.timing.clock === clock)
    })).sort((a, b) => b.channels.length - a.channels.length);
    const reference = groups[0];
    const zeroBearing = reference.channels.some(channel => channel.timing.first !== 0);
    const usable = reference.channels.length > 0 && (reference.clock !== 'capture' || zeroBearing);
    const origin = !usable ? null : reference.clock === 'session' ? 0
      : Math.min(...reference.channels.map(channel => channel.timing.first));
    for (const channel of channels) {
      channel.offset = origin !== null && reference.channels.includes(channel) ? (channel.timing.first - origin) / 1000 : null;
    }
    return { origin, clock: usable ? reference.clock : null, measured: measured.length };
  }

  function scanBounds(points, time) {
    let low = 0;
    let high = points.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (points[mid][0] < time) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  function nearest(points, time) {
    const index = scanBounds(points, time);
    const before = points[index - 1];
    const after = points[index];
    if (!before || !after) return before || after || null;
    return time - before[0] < after[0] - time ? before : after;
  }

  function csvText(rows) {
    return rows.map(row => row.map(value => {
      if (value == null) return '';
      let text = String(value);
      if (typeof value === 'string' && /^[\s\r\n]*[=+@-]/.test(text)) text = "'" + text;
      return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    }).join(',')).join('\r\n') + '\r\n';
  }

  global.RecordingAnalysis = { parseCsv, readTiming, readSignals, alignChannels, scanBounds, nearest, csvText, positive };
})(globalThis);
