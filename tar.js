/*
 * Minimal, dependency-free TAR reader for the browser.
 * Reads headers sequentially from a File/Blob and exposes each member as a
 * Blob slice, so a large session TAR is never fully materialised in memory.
 *
 * Supports: ustar, GNU long name (typeflag 'L'), POSIX/PAX path ('x'/'g'),
 * base-256 numeric fields, regular files ('0', '\0', ' '), and sparse-safe
 * padding handling.
 */
(function (global) {
  'use strict';

  var BLOCK = 512;

  function toString(bytes) {
    var end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end--;
    var out = '';
    var chunk = 0x8000;
    for (var i = 0; i < end; i += chunk) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, end)));
    }
    return out;
  }

  function numeric(bytes) {
    if (!bytes.length) return 0;
    // GNU base-256: high bit set.
    if (bytes[0] & 0x80) {
      var negative = !!(bytes[0] & 0x40);
      var value = BigInt(bytes[0] & 0x3f);
      for (var i = 1; i < bytes.length; i++) value = (value << 8n) | BigInt(bytes[i]);
      if (negative) value = -value;
      var n = Number(value);
      return Number.isFinite(n) ? n : 0;
    }
    var s = '';
    for (var j = 0; j < bytes.length; j++) {
      var b = bytes[j];
      if (b === 0 || b === 32) break;
      s += String.fromCharCode(b);
    }
    s = s.trim();
    if (!s) return 0;
    var parsed = parseInt(s, 8);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function paxRecords(text) {
    var out = {};
    var i = 0;
    while (i < text.length) {
      var space = text.indexOf(' ', i);
      if (space < 0) break;
      var len = parseInt(text.slice(i, space), 10);
      if (!Number.isFinite(len) || len <= 0 || i + len > text.length) break;
      var record = text.slice(space + 1, i + len);
      i += len;
      var eq = record.indexOf('=');
      if (eq > 0) {
        out[record.slice(0, eq)] = record.slice(eq + 1).replace(/\n$/, '');
      }
    }
    return out;
  }

  /**
   * Parse a TAR File/Blob into [{name, size, blob, type}].
   * onProgress receives a number in [0, 1].
   */
  async function readTar(file, onProgress) {
    var entries = [];
    var offset = 0;
    var total = file.size;
    var decoder = new TextDecoder();
    var longName = null;
    var globalPax = {};
    var filePax = null;
    var inspected = 0;

    while (offset + BLOCK <= total) {
      var headerBuf = await file.slice(offset, offset + BLOCK).arrayBuffer();
      var h = new Uint8Array(headerBuf);

      var zero = true;
      for (var z = 0; z < BLOCK; z++) {
        if (h[z] !== 0) { zero = false; break; }
      }
      if (zero) break; // Two zero blocks (or EOF) mark the end of the archive.

      var size = numeric(h.subarray(124, 136));
      var type = String.fromCharCode(h[156] || 48);
      var prefix = toString(h.subarray(345, 500));
      var name = toString(h.subarray(0, 100));
      if (prefix) name = prefix + '/' + name;
      var dataOffset = offset + BLOCK;

      if (!Number.isFinite(size) || size < 0 || dataOffset + size > total) {
        throw new Error('TAR 头部损坏：成员 "' + name + '" 的大小无效');
      }

      if (type === 'L') {
        var lbuf = await file.slice(dataOffset, dataOffset + size).arrayBuffer();
        longName = toString(new Uint8Array(lbuf)).replace(/\n$/, '').replace(/\0$/, '');
      } else if (type === 'K') {
        longName = null; // GNU long link name — not needed for our members.
      } else if (type === 'x') {
        var xbuf = await file.slice(dataOffset, dataOffset + size).arrayBuffer();
        filePax = paxRecords(decoder.decode(xbuf));
      } else if (type === 'g') {
        var gbuf = await file.slice(dataOffset, dataOffset + size).arrayBuffer();
        globalPax = paxRecords(decoder.decode(gbuf));
      } else if (type === '0' || type === '\0' || type === ' ' || type === '7') {
        var finalName = (filePax && filePax.path) || longName || name;
        finalName = finalName.replace(/^\.\//, '');
        entries.push({
          name: finalName,
          size: size,
          type: type,
          blob: file.slice(dataOffset, dataOffset + size)
        });
        longName = null;
        filePax = null;
      }

      offset = dataOffset + Math.ceil(size / BLOCK) * BLOCK;
      inspected++;
      if (onProgress && (inspected % 24 === 0)) onProgress(Math.min(1, offset / total));
    }

    if (onProgress) onProgress(1);
    if (!entries.length) throw new Error('TAR 中没有找到任何文件');
    return entries;
  }

  global.TarReader = { readTar: readTar };
})(window);
