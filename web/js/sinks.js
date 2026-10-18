// Where received bytes go. The Origin Private File System keeps large files
// out of memory when the browser supports writable OPFS handles; otherwise
// chunks are folded into a Blob every few MB, which browsers can page to disk.

const PREFIX = 'incoming-';

export function opfsSupported() {
  return !!(navigator.storage && navigator.storage.getDirectory && self.FileSystemFileHandle &&
    'createWritable' in FileSystemFileHandle.prototype);
}

class MemorySink {
  constructor(mime) {
    this.mime = mime;
    this.blob = new Blob([], { type: mime });
    this.parts = [];
    this.pending = 0;
  }
  async write(u8) {
    this.parts.push(u8);
    this.pending += u8.byteLength;
    if (this.pending >= 8 * 1024 * 1024) this.fold();
  }
  fold() {
    this.blob = new Blob([this.blob, ...this.parts], { type: this.mime });
    this.parts = [];
    this.pending = 0;
  }
  async finish(name) {
    this.fold();
    return new File([this.blob], name, { type: this.mime });
  }
  async discard() {
    this.parts = [];
    this.blob = null;
  }
}

// Received files are written in segments of about SEG bytes, one OPFS file each. A writable
// stream only becomes the file when it is closed, so an unclosed one is lost on reload; closing
// every segment keeps everything up to the last segment boundary, and a reloaded page resumes
// from there. The finished file is a Blob made of the segment files, with no extra copy.
const SEG = 16 * 1024 * 1024;

class OpfsSink {
  /**
   * @param {string} key segment files are named `incoming-<key>.<n>`
   * @param {number[]} segs sizes of segments already on disk (when resuming after a reload)
   */
  static async create(key, mime, segs = []) {
    const s = new OpfsSink();
    s.key = key;
    s.mime = mime;
    s.root = await navigator.storage.getDirectory();
    s.segs = segs.slice();
    s.parts = [];
    s.pending = 0;
    s.onCommit = null; // called with the segment sizes each time one is closed
    await s.openSeg();
    return s;
  }
  segName(i) {
    return `${PREFIX}${this.key}.${i}`;
  }
  /** Bytes that survive a reload. */
  get committed() {
    return this.segs.reduce((a, b) => a + b, 0);
  }
  async openSeg() {
    this.handle = await this.root.getFileHandle(this.segName(this.segs.length), { create: true });
    this.w = await this.handle.createWritable({ keepExistingData: false });
    this.segBytes = 0;
  }
  // Each write() is a round trip to the browser's storage process, so batch ~1 MB at a time.
  async write(u8) {
    this.parts.push(u8);
    this.pending += u8.byteLength;
    if (this.pending >= 1024 * 1024) await this.flush();
  }
  async flush() {
    if (!this.pending) return;
    const blob = new Blob(this.parts);
    this.parts = [];
    this.pending = 0;
    await this.w.write(blob);
    this.segBytes += blob.size;
    if (this.segBytes >= SEG) {
      await this.w.close();
      this.segs.push(this.segBytes);
      if (this.onCommit) await this.onCommit(this.segs.slice());
      await this.openSeg();
    }
  }
  async finish(name) {
    await this.flush();
    await this.w.close();
    const files = [];
    for (let i = 0; i <= this.segs.length; i++) files.push(await (await this.root.getFileHandle(this.segName(i))).getFile());
    return new File(files, name, { type: this.mime });
  }
  async discard() {
    try { await this.w.abort(); } catch {}
    await discardSegments(this.key, this.segs.length + 1);
  }
}

/** Remove the segment files of a partial transfer. */
export async function discardSegments(key, count) {
  try {
    const root = await navigator.storage.getDirectory();
    for (let i = 0; i < count; i++) await root.removeEntry(`${PREFIX}${key}.${i}`).catch(() => {});
  } catch {}
}

/** The committed segments of a partial transfer as one Blob, or null if any is missing or short. */
export async function readSegments(key, segs) {
  try {
    const root = await navigator.storage.getDirectory();
    const files = [];
    for (let i = 0; i < segs.length; i++) {
      const f = await (await root.getFileHandle(`${PREFIX}${key}.${i}`)).getFile();
      if (f.size !== segs[i]) return null;
      files.push(f);
    }
    return new Blob(files);
  } catch {
    return null;
  }
}

export async function createSink(key, mime, size, segs) {
  if (size > 4 * 1024 * 1024 && opfsSupported()) {
    try {
      return await OpfsSink.create(key, mime || 'application/octet-stream', segs);
    } catch (e) {
      console.warn('softdrop: OPFS unavailable, using memory', e);
    }
  }
  return new MemorySink(mime || 'application/octet-stream');
}

/** Remove received files left over from earlier visits, except the ones named in `keep`. */
export async function cleanupStorage(keep = new Set()) {
  if (!navigator.storage || !navigator.storage.getDirectory) return;
  try {
    const root = await navigator.storage.getDirectory();
    const names = [];
    for await (const name of root.keys()) if (name.startsWith(PREFIX) && !keep.has(name)) names.push(name);
    for (const name of names) await root.removeEntry(name).catch(() => {});
  } catch {}
}

/** File names of the committed segments of a partial transfer. */
export function segmentNames(key, segs) {
  return segs.map((_, i) => `${PREFIX}${key}.${i}`);
}
