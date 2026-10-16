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

class OpfsSink {
  static async create(key, mime) {
    const s = new OpfsSink();
    s.mime = mime;
    s.root = await navigator.storage.getDirectory();
    s.fname = PREFIX + key;
    s.handle = await s.root.getFileHandle(s.fname, { create: true });
    s.w = await s.handle.createWritable({ keepExistingData: false });
    s.parts = [];
    s.pending = 0;
    return s;
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
  }
  async finish(name) {
    await this.flush();
    await this.w.close();
    const f = await this.handle.getFile();
    return new File([f], name, { type: this.mime });
  }
  async discard() {
    try { await this.w.abort(); } catch {}
    try { await this.root.removeEntry(this.fname); } catch {}
  }
}

export async function createSink(key, mime, size) {
  if (size > 4 * 1024 * 1024 && opfsSupported()) {
    try {
      return await OpfsSink.create(key, mime || 'application/octet-stream');
    } catch (e) {
      console.warn('softdrop: OPFS unavailable, using memory', e);
    }
  }
  return new MemorySink(mime || 'application/octet-stream');
}

/** Remove received files left over from earlier visits. */
export async function cleanupStorage() {
  if (!navigator.storage || !navigator.storage.getDirectory) return;
  try {
    const root = await navigator.storage.getDirectory();
    for await (const name of root.keys()) if (name.startsWith(PREFIX)) await root.removeEntry(name).catch(() => {});
  } catch {}
}
