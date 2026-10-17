// Debug log. Off by default. `?debug=1` turns it on for this browser (remembered),
// `?debug=0` turns it off. When on, lines go to the console, to the in-page log
// panel, and to the server log (so phones can be followed without a console).
// Lines describe connections and transfers; they never contain file contents.

const KEY = 'softdrop-debug';
const MAX = 800;

let enabled = false;
try {
  const q = new URLSearchParams(location.search).get('debug');
  if (q === '1' || q === '0') localStorage.setItem(KEY, q);
  enabled = localStorage.getItem(KEY) === '1';
} catch {}

const lines = [];
const listeners = new Set();
let remote = null;
let outbox = [];
const t0 = performance.now();

function fmt(v) {
  if (v === undefined || v === null) return '';
  const s = typeof v === 'string' ? v : typeof v === 'number' ? String(Math.round(v * 100) / 100) : JSON.stringify(v);
  return /^[\w.:/@+%()-]*$/.test(s) && s !== '' ? s : JSON.stringify(s);
}

export function debugOn() {
  return enabled;
}

/** dlog('rtc', 'ice state', { state: 'checking' }) */
export function dlog(cat, msg, fields) {
  if (!enabled) return;
  const now = new Date();
  const ts = now.toTimeString().slice(0, 8) + '.' + String(now.getMilliseconds()).padStart(3, '0');
  let line = `${ts} +${((performance.now() - t0) / 1000).toFixed(1)}s [${cat}] ${msg}`;
  if (fields) for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== '') line += ` ${k}=${fmt(v)}`;
  lines.push(line);
  if (lines.length > MAX) lines.splice(0, lines.length - MAX);
  console.log('%c[softdrop]', 'color:#A04E30', line);
  listeners.forEach((fn) => fn(line));
  if (remote) {
    outbox.push(line);
    if (outbox.length > 400) outbox.splice(0, outbox.length - 400);
  }
}

export function onLine(fn) {
  listeners.add(fn);
}

export function allLines() {
  return lines.slice();
}

export function clearLines() {
  lines.length = 0;
}

/** Ship lines to the server in small batches through the signaling socket. */
export function sendRemote(send) {
  if (!enabled) return;
  remote = send;
  outbox = lines.slice(-100);
  setInterval(() => {
    if (!outbox.length) return;
    const batch = outbox.splice(0, 50);
    if (!remote(batch)) outbox.unshift(...batch); // not connected: keep for later
  }, 1000);
}
