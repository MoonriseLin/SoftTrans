// One-line structured logs: `LEVEL event key=value ...`, for journald or a terminal.
// LOG_LEVEL=debug|info|warn|error (default info). Never pass file data or keys here.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const min = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
// journald stamps every line already; add our own timestamp only in a terminal.
const stamp = !process.env.INVOCATION_ID;

function fmt(v) {
  if (v === undefined) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return /^[\w.:/@+-]*$/.test(s) && s !== '' ? s : JSON.stringify(s);
}

export function log(level, event, fields = {}) {
  if ((LEVELS[level] ?? 20) < min) return;
  const parts = [level.toUpperCase().padEnd(5), event];
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== '') parts.push(`${k}=${fmt(v)}`);
  const line = (stamp ? new Date().toISOString() + ' ' : '') + parts.join(' ');
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

export const logLevel = Object.keys(LEVELS).find((k) => LEVELS[k] === min);
