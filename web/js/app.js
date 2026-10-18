import { Identity, idForPub, iconForKind } from './identity.js';
import { Signaling } from './signaling.js';
import { PeerManager } from './rtc.js';
import { TransferEngine, isLive } from './transfer.js';
import { cleanupStorage, opfsSupported } from './sinks.js';
import { dlog, debugOn, onLine, allLines, clearLines, sendRemote } from './log.js';
import { t, tr, LANGS, getLang, setLang, onLangChange, applyStatic } from './i18n.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const ICON = {
  laptop: '<rect x="4" y="5" width="16" height="11" rx="2"/><path d="M2.5 19h19"/>',
  tablet: '<rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M11 18h2"/>',
  desktop: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M9 20h6M12 16v4"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  text: '<path d="M5 6h14M5 12h14M5 18h9"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  auto: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor"/>',
};
function svg(name, size = 22) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;
}

// Under 1 MB in KB, under 1 GB in MB, else GB.
function fmtB(b) {
  if (b < 1e6) return (b / 1e3).toFixed(b < 1e4 ? 1 : 0) + ' KB';
  if (b < 1e9) return (b / 1e6).toFixed(1) + ' MB';
  return (b / 1e9).toFixed(2) + ' GB';
}
const routeLabel = (r) => t('route.' + r);
// Alias for places where a local variable named `t` (a transfer) shadows the translator.
const tt = t;
function routeChip(route, via) {
  if (route) return `<span class="route ${route === 'relay' ? 'relay' : route === 'lan' ? 'lan' : 'direct'}">${esc(routeLabel(route))}</span>`;
  return `<span class="route pending">${esc(t(via === 'paired' ? 'route.pendingPaired' : 'route.pendingLan'))}</span>`;
}

/* ---------- theme (works before anything else loads) ---------- */
const modes = ['system', 'light', 'dark'];
let mode = 'system';
try { const m = localStorage.getItem('softdrop-theme'); if (modes.includes(m)) mode = m; } catch {}
function applyTheme() {
  const r = document.documentElement;
  if (mode === 'system') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', mode);
  $('themeBtn').innerHTML = svg(mode === 'light' ? 'sun' : mode === 'dark' ? 'moon' : 'auto', 20);
  $('themeBtn').setAttribute('aria-label', t('theme.aria', { mode: t('theme.' + mode) }));
  $('themeBtn').title = t('theme.aria', { mode: t('theme.' + mode) });
}
$('themeBtn').addEventListener('click', () => {
  mode = modes[(modes.indexOf(mode) + 1) % modes.length];
  try { localStorage.setItem('softdrop-theme', mode); } catch {}
  applyTheme();
});
applyTheme();

/* ---------- language (remembered in this browser) ---------- */
const langSel = $('langSel');
langSel.innerHTML = LANGS.map((l) => `<option value="${l.code}">${l.label}</option>`).join('');
langSel.value = getLang();
langSel.addEventListener('change', () => setLang(langSel.value));
applyStatic();
onLangChange(() => { langSel.value = getLang(); applyTheme(); });

function notice(html) {
  const n = $('notice');
  if (!html) { n.hidden = true; n.innerHTML = ''; return; }
  n.innerHTML = html;
  n.hidden = false;
}

/* ---------- start ---------- */
main().catch((e) => {
  console.error(e);
  dlog('app', 'START FAILED', { err: e.message || String(e) });
  const why = () => esc(tr(e.message) || String(e));
  notice(esc(t('start.fail', { why: '\u0000' })).replace('\u0000', why()));
  $('radarStatus').textContent = t('status.notConnected');
});

async function main() {
  if (!window.RTCPeerConnection) throw new Error('start.noRtc');
  if (!window.isSecureContext) throw new Error('start.https');
  const me = await Identity.load();
  cleanupStorage();
  dlog('app', 'boot', {
    id: me.id.slice(0, 8), name: me.name, kind: me.kind, lang: getLang(), paired: Object.keys(me.trusted).length,
    standalone: matchMedia('(display-mode: standalone)').matches || !!navigator.standalone,
    opfs: opfsSupported(), wakeLock: 'wakeLock' in navigator, ua: navigator.userAgent,
  });

  const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  const sig = new Signaling(me, wsUrl);
  /** @type {Map<string, {id, name, kind, pub, via, icon}>} online, verified peers */
  const presence = new Map();
  /** last known info for any peer we have seen, so old transfers keep a name */
  const known = new Map(Object.values(me.trusted).map((p) => [p.id, p]));
  const peers = new PeerManager(sig, me, (id) => presence.get(id) || null);
  const engine = new TransferEngine(peers, (id) => me.isTrusted(id));

  let selected = null;
  let files = [];
  const order = []; // transfer ids, newest first
  const slots = new Map(); // device id -> slot index

  $('meDot').innerHTML = svg(me.icon, 26);
  $('myFp').textContent = me.id.slice(0, 16).match(/.{4}/g).join(' ');

  /* ---------- name ---------- */
  function renderName() { $('nameBtn').textContent = me.name; }
  renderName();
  $('nameBtn').addEventListener('click', () => {
    $('nameBtn').hidden = true;
    $('nameForm').hidden = false;
    $('nameInput').value = me.name;
    $('nameInput').focus();
    $('nameInput').select();
  });
  $('nameForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('nameInput').value.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (name && name !== me.name) {
      await me.rename(name);
      sig.send({ t: 'rename', name });
    }
    $('nameForm').hidden = true;
    $('nameBtn').hidden = false;
    renderName();
  });
  $('nameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { $('nameForm').hidden = true; $('nameBtn').hidden = false; }
  });

  /* ---------- presence ---------- */
  async function addPeer(p) {
    if (!p || typeof p.id !== 'string' || typeof p.pub !== 'string') return;
    if ((await idForPub(p.pub)) !== p.id) return console.warn('softdrop: peer id does not match its key', p.id);
    const prev = presence.get(p.id);
    const peer = { ...prev, ...p, icon: iconForKind(p.kind) };
    presence.set(p.id, peer);
    if (!prev || prev.via !== p.via || prev.name !== p.name) dlog('app', prev ? 'peer updated' : 'peer appeared', { peer: p.id.slice(0, 8), name: p.name, kind: p.kind, via: p.via, paired: me.isTrusted(p.id) });
    known.set(p.id, peer);
    if (me.isTrusted(p.id) && (me.trusted[p.id].name !== p.name || me.trusted[p.id].kind !== p.kind)) {
      me.trusted[p.id].name = p.name;
      me.trusted[p.id].kind = p.kind;
    }
    if (!prev) engine.retry(p.id);
    renderAll();
  }

  sig.addEventListener('welcome', async (e) => {
    const ids = new Set(e.detail.peers.map((p) => p.id));
    for (const id of [...presence.keys()]) if (!ids.has(id)) presence.delete(id);
    for (const p of e.detail.peers) await addPeer(p);
    renderAll();
  });
  sig.addEventListener('peer-joined', (e) => addPeer(e.detail.peer));
  sig.addEventListener('peer-updated', (e) => addPeer(e.detail.peer));
  sig.addEventListener('peer-left', (e) => {
    dlog('app', 'peer gone', { peer: e.detail.id.slice(0, 8) });
    const id = e.detail.id;
    presence.delete(id);
    engine.peerGone(id);
    // Keep the selection: phones drop off briefly when the screen locks, and come back.
    renderAll();
  });
  sig.addEventListener('state', (e) => {
    const s = e.detail;
    if (s === 'replaced') {
      notice(`${esc(t('replaced'))} <button type="button" class="link" id="useHere">${esc(t('useHere'))}</button>`);
      $('useHere').addEventListener('click', () => sig.kick());
      presence.clear();
    } else if (s === 'closed') {
      notice('');
    } else if (s === 'open') {
      notice('');
    }
    renderRadar();
  });

  peers.addEventListener('link', (e) => {
    const link = e.detail;
    link.addEventListener('state', () => { renderRadar(); renderTo(); });
    link.addEventListener('route', () => { renderRadar(); renderTo(); });
  });

  /* ---------- radar ---------- */
  // Positions on the 3:2 radar, clear of "You" in the middle.
  const SLOTS = [
    { x: 19, y: 32 }, { x: 81, y: 32 }, { x: 19, y: 74 }, { x: 81, y: 74 },
  ];
  function slotFor(id) {
    if (!slots.has(id)) {
      const used = new Set([...slots.entries()].filter(([k]) => presence.has(k)).map(([, v]) => v));
      let i = 0;
      while (used.has(i)) i++;
      slots.set(id, i);
    }
    const i = slots.get(id);
    if (i < SLOTS.length) return SLOTS[i];
    const a = (i * 2.399) % (2 * Math.PI); // golden-angle spread for crowds
    return { x: 50 + Math.cos(a) * 34, y: 50 + Math.sin(a) * 30 };
  }
  function linkOf(id) { return peers.links.get(id); }
  function routeOf(id) { const l = linkOf(id); return l && l.state === 'open' ? l.route : null; }
  function devLabel(p) { return p ? p.name + ' · ' + p.kind : t('leftDevice'); }

  const radar = $('radar');
  function renderRadar() {
    const s = sig.state;
    const keep = new Set(presence.keys());
    radar.querySelectorAll('.device').forEach((b) => { if (!keep.has(b.dataset.id)) b.remove(); });
    for (const p of presence.values()) {
      let b = radar.querySelector(`.device[data-id="${CSS.escape(p.id)}"]`);
      if (!b) {
        b = document.createElement('button');
        b.type = 'button';
        b.dataset.id = p.id;
        radar.appendChild(b);
      }
      const pos = slotFor(p.id);
      const route = routeOf(p.id);
      const link = linkOf(p.id);
      const relay = route === 'relay' || (!route && p.via === 'paired');
      b.className = 'device' + (relay ? ' relay' : '') + (link && link.state === 'connecting' ? ' connecting' : '');
      b.style.setProperty('--x', pos.x + '%');
      b.style.setProperty('--y', pos.y + '%');
      b.setAttribute('aria-pressed', p.id === selected ? 'true' : 'false');
      const sub = route ? (route === 'relay' ? t('kind.relay', { kind: p.kind }) : p.kind) : p.via === 'paired' ? t('kind.paired', { kind: p.kind }) : p.kind;
      b.setAttribute('aria-label', devLabel(p) + (route ? ', ' + routeLabel(route) : '') + (me.isTrusted(p.id) ? ', ' + t('a11y.paired') : ''));
      b.innerHTML = `<span class="avatar">${svg(p.icon, 24)}</span>` +
        (me.isTrusted(p.id) ? `<span class="badge" title="${esc(t('badge.paired'))}">${svg('check', 12)}</span>` : '') +
        `<span class="dname">${esc(p.name)}</span><span class="dkind">${esc(sub)}</span>`;
    }
    const lan = [...presence.values()].filter((p) => p.via === 'lan').length;
    const rel = presence.size - lan;
    $('radarEmpty').hidden = presence.size > 0 || s !== 'open';
    if (s === 'open') {
      $('radarStatus').textContent = presence.size
        ? (rel ? t('status.countPaired', { n: lan, m: rel }) : t('status.count', { n: lan }))
        : t('radar.looking');
    } else if (s === 'replaced') {
      $('radarStatus').textContent = t('status.paused');
    } else {
      $('radarStatus').textContent = t(s === 'connecting' ? 'status.connecting' : 'status.reconnecting');
    }
  }
  radar.addEventListener('click', (e) => {
    const b = e.target.closest('.device');
    if (!b) return;
    select(b.dataset.id);
    renderRadar();
    renderTo();
    updateSend();
  });
  function select(id, auto) {
    selected = id;
    dlog('app', auto ? 'auto-selected (only device)' : 'selected', { peer: id.slice(0, 8), link: peers.links.get(id)?.state || 'none' });
    // Warm up the connection so the route label is ready and sending starts at once.
    peers.get(id).ready().catch(() => {});
  }
  // With exactly one device around, it is the target without a tap.
  function autoSelect() {
    if (presence.size !== 1 || (selected && presence.has(selected))) return;
    select(presence.keys().next().value, true);
  }

  /* ---------- send card ---------- */
  const ta = $('text');
  const sendBtn = $('send');
  const zone = $('zone');
  function renderTo() {
    const p = selected && presence.get(selected);
    if (!p && selected && known.has(selected)) {
      $('to').innerHTML = `<span class="k">${esc(t('to.waitBack', { name: known.get(selected).name }))}</span>`;
      return;
    }
    if (!p) {
      $('to').innerHTML = `<span class="k">${esc(t(presence.size ? 'to.pick' : 'to.none'))}</span>`;
      return;
    }
    const link = linkOf(p.id);
    let extra = '';
    if (link && link.state === 'connecting') extra = `<span class="speed">${esc(t('connecting'))}</span>`;
    else if (link && link.state === 'failed') extra = `<span class="err">${esc(tr(link.lastError || 'err.connect'))}</span>`;
    else if (link && link.state === 'open' && link.farHairpin) extra = `<span class="hint">${esc(t('hint.vpn'))}</span>`;
    $('to').innerHTML = `<span class="k">${esc(t('to.label'))}</span><strong>${esc(devLabel(p))}</strong>${routeChip(routeOf(p.id), p.via)}${extra}`;
  }
  peers.addEventListener('link', (e) => {
    e.detail.addEventListener('state', (ev) => { if (ev.detail.state === 'failed') e.detail.lastError = ev.detail.why; });
  });
  function renderStaged() {
    $('staged').innerHTML = files.map((f, i) =>
      `<span class="chip"><span class="nm">${esc(f.name)}</span><span class="sz">${fmtB(f.size)}</span>` +
      `<button type="button" class="chip-x" data-i="${i}" aria-label="${esc(t('remove', { name: f.name }))}">${svg('x', 14)}</button></span>`).join('');
  }
  function updateSend() {
    const n = files.length + (ta.value.trim() ? 1 : 0);
    sendBtn.disabled = !(selected && presence.has(selected) && n);
    sendBtn.textContent = n > 1 ? t('send.n', { n }) : t('send');
  }
  function addFiles(list) {
    for (const f of list) files.push(f);
    renderStaged();
    updateSend();
  }
  $('staged').addEventListener('click', (e) => {
    const x = e.target.closest('.chip-x');
    if (!x) return;
    files.splice(Number(x.dataset.i), 1);
    renderStaged();
    updateSend();
  });
  $('pick').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  ta.addEventListener('input', updateSend);
  ta.addEventListener('paste', (e) => {
    const fs = e.clipboardData && e.clipboardData.files;
    if (fs && fs.length) { e.preventDefault(); addFiles(fs); }
  });
  ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'dragleave' && zone.contains(e.relatedTarget)) return;
    zone.classList.remove('over');
    if (ev === 'drop' && e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  }));
  // Dropping a file anywhere else on the page should not navigate away from it.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  // Paste button: reads the clipboard directly, so no long-press or keyboard shortcut is needed.
  // Images and files are staged; text goes into the text box at the cursor.
  const pasteBtn = $('pasteBtn');
  pasteBtn.hidden = !(navigator.clipboard && (navigator.clipboard.read || navigator.clipboard.readText));
  const flashPaste = (key) => {
    pasteBtn.textContent = t(key);
    setTimeout(() => { pasteBtn.textContent = t('paste'); }, 1800);
  };
  pasteBtn.addEventListener('click', async () => {
    const got = { files: [], text: '' };
    try {
      if (navigator.clipboard.read) {
        for (const item of await navigator.clipboard.read()) {
          const type = item.types.find((x) => !x.startsWith('text/'));
          if (type) {
            const blob = await item.getType(type);
            const ext = (type.split('/')[1] || 'bin').replace(/[^\w]/g, '').slice(0, 8) || 'bin';
            got.files.push(new File([blob], `pasted-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`, { type }));
          } else if (item.types.includes('text/plain')) {
            got.text += await (await item.getType('text/plain')).text();
          }
        }
      } else {
        got.text = await navigator.clipboard.readText();
      }
    } catch (err) {
      dlog('app', 'paste failed', { err: err && err.name });
      flashPaste('pasteFail');
      return;
    }
    dlog('app', 'paste', { files: got.files.length, textChars: got.text.length });
    if (!got.files.length && !got.text) { flashPaste('pasteEmpty'); return; }
    if (got.files.length) addFiles(got.files);
    if (got.text) {
      ta.setRangeText(got.text, ta.selectionStart, ta.selectionEnd, 'end');
      ta.focus();
      updateSend();
    }
  });
  // Pasting a file anywhere on the page stages it.
  document.addEventListener('paste', (e) => {
    if (e.target === ta) return;
    const fs = e.clipboardData && e.clipboardData.files;
    if (fs && fs.length) { e.preventDefault(); addFiles(fs); }
  });
  sendBtn.addEventListener('click', () => {
    dlog('app', 'send clicked', { to: selected && selected.slice(0, 8), files: files.length, text: !!ta.value.trim() });
    if (!selected || !presence.has(selected)) return;
    const text = ta.value.trim();
    // The engine's update event adds each transfer to the list.
    for (const f of files) engine.sendFile(selected, f);
    if (text) engine.sendText(selected, text);
    ta.value = '';
    files = [];
    renderStaged();
    updateSend();
    renderList();
  });

  /* ---------- transfers ---------- */
  const list = $('list');
  const C = 2 * Math.PI * 15;
  const rendered = new Map(); // tid -> signature of what is drawn

  function ringHTML(p) {
    return `<div class="prog" role="img" aria-label="${esc(t('progress.aria'))}"><svg width="44" height="44" viewBox="0 0 36 36">` +
      `<circle cx="18" cy="18" r="15" fill="none" stroke="var(--line)" stroke-width="3"/>` +
      `<circle data-ring cx="18" cy="18" r="15" fill="none" stroke="var(--accent-ink)" stroke-width="3" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - p)}" transform="rotate(-90 18 18)"/>` +
      `</svg><span data-pct>${Math.round(p * 100)}%</span></div>`;
  }
  const cancelBtn = (t) => `<button type="button" class="cancel-x" data-act="cancel" data-id="${t.tid}" aria-label="${esc(tt('cancel'))}">${svg('x', 14)}</button>`;
  const frac = (t) => (t.size ? t.done / t.size : t.status === 'done' ? 1 : 0);
  const speedText = (t) => `${fmtB(t.done)} / ${fmtB(t.size)}` + (t.speed > 0 ? ` · ${fmtB(t.speed)}/s` : '');

  function itemHTML(t, isNew) {
    const p = presence.get(t.peer) || known.get(t.peer);
    const who = devLabel(p);
    const titleTxt = t.kind === 'file' ? t.name : tt('item.text');
    let end = '', endCls = 'end', speed = '', note = '';
    let line = esc(tt(t.dir === 'in' ? 'item.from' : 'item.to', { who, size: fmtB(t.size) }));
    switch (t.status) {
      case 'pending':
        endCls += ' buttons';
        end = `<button type="button" class="btn primary sm" data-act="accept" data-id="${t.tid}">${esc(tt('accept'))}</button>` +
          `<button type="button" class="btn ghost sm" data-act="decline" data-id="${t.tid}">${esc(tt('decline'))}</button>`;
        line = esc(tt('item.wants', { size: fmtB(t.size), who }));
        note = me.isTrusted(t.peer) ? `<span class="trust yes">${esc(tt('trust.yes'))}</span>` : `<span class="trust">${esc(tt('trust.no'))}</span>`;
        if (t.error) note += `<span class="err">${esc(tr(t.error))}</span>`;
        break;
      case 'waiting':
        end = ringHTML(0) + cancelBtn(t);
        speed = `<span class="speed">${esc(tt('connecting'))}</span>`;
        break;
      case 'offered':
        end = ringHTML(0) + cancelBtn(t);
        speed = `<span class="speed">${esc(tt('st.waitingAccept'))}</span>`;
        break;
      case 'active':
        end = ringHTML(frac(t)) + cancelBtn(t);
        speed = `<span class="speed" data-speed>${speedText(t)}</span>`;
        break;
      case 'paused':
        end = ringHTML(frac(t)) + cancelBtn(t);
        speed = `<span class="speed">${esc(tt(t.dir === 'out' ? 'st.pausedOut' : 'st.pausedIn'))}</span>`;
        break;
      case 'verifying':
        end = ringHTML(1);
        speed = `<span class="speed">${esc(tt('st.checking'))}</span>`;
        break;
      case 'done':
        end = `<span class="done">${svg('check', 18)}${esc(tt(t.dir === 'in' ? 'st.received' : 'st.sent'))}</span>`;
        if (t.dir === 'in' && t.kind === 'text') end += `<button type="button" class="btn ghost sm" data-act="copy" data-id="${t.tid}">${esc(tt('copy'))}</button>`;
        if (t.dir === 'in' && t.kind === 'file') {
          end += `<button type="button" class="btn primary sm" data-act="save" data-id="${t.tid}">${esc(tt('save'))}</button>`;
          if (canShare(t.file)) end += `<button type="button" class="btn ghost sm" data-act="share" data-id="${t.tid}">${esc(tt('share'))}</button>`;
        }
        break;
      case 'rejected': end = `<span class="muted">${esc(tt('st.declined'))}</span>`; break;
      case 'canceled': end = `<span class="muted">${esc(tt('st.canceled'))}</span>`; break;
      case 'failed': end = `<span class="muted">${esc(tt('st.failed'))}</span>`; note = `<span class="err">${esc(tr(t.error))}</span>`; break;
    }
    const showText = t.kind === 'text' && t.text != null && (t.dir === 'out' || t.status === 'done');
    let thumb = '';
    if (t.dir === 'in' && t.status === 'done' && t.kind === 'file' && /^image\/(png|jpe?g|gif|webp|avif)$/.test(t.mime) && t.size < 30e6) {
      thumb = `<img class="thumb" alt="" src="${urlFor(t)}">`;
    }
    return `<li class="item${isNew ? ' new' : ''}" data-id="${t.tid}">` +
      `<div class="ico">${svg(t.kind === 'file' ? 'file' : 'text', 22)}</div>` +
      `<div class="meta"><div class="title">${esc(titleTxt)}</div><div class="sub">${line}</div>` +
      `<div class="chips">${t.route ? routeChip(t.route) : ''}${speed}${note}</div>` +
      (showText ? `<p class="preview">${esc(t.text)}</p>` : '') + thumb + `</div>` +
      `<div class="${endCls}">${end}</div></li>`;
  }

  const sigOf = (t) => [t.status, t.error, t.route, t.text != null, !!presence.get(t.peer)].join('|');

  function renderList() {
    if (!order.length) {
      list.innerHTML = `<li class="empty">${esc(tt('list.empty'))}</li>`;
      return;
    }
    list.innerHTML = order.map((tid) => {
      const t = engine.all.get(tid);
      const isNew = !rendered.has(tid);
      rendered.set(tid, sigOf(t));
      return itemHTML(t, isNew);
    }).join('');
    updateTitle();
    renderSaveAll();
  }

  /* ---------- Save all: every received file not saved yet ---------- */
  const saveAllBtn = $('saveAll');
  const unsaved = () => order.map((tid) => engine.all.get(tid)).filter((t) => t && t.dir === 'in' && t.kind === 'file' && t.status === 'done' && !t.saved);
  function renderSaveAll() {
    const n = unsaved().length;
    saveAllBtn.hidden = n < 2;
    saveAllBtn.textContent = tt('saveAll', { n });
  }
  function download(t) {
    const a = document.createElement('a');
    a.href = urlFor(t);
    a.download = t.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    t.saved = true;
  }
  saveAllBtn.addEventListener('click', async () => {
    const items = unsaved().reverse(); // oldest first
    dlog('app', 'save all', { files: items.length });
    const files = items.map((t) => t.file);
    // Phones: one share sheet for all files ("Save to Files" / "Save images").
    if (canShare(files)) {
      try {
        await navigator.share({ files });
        items.forEach((t) => { t.saved = true; });
      } catch {}
    } else {
      // Desktop: one download each, spaced out so the browser does not drop any.
      for (const t of items) {
        download(t);
        await new Promise((r) => setTimeout(r, 350));
      }
    }
    renderSaveAll();
  });

  function patchProgress(t) {
    const li = list.querySelector(`[data-id="${t.tid}"]`);
    if (!li) return;
    const ring = li.querySelector('[data-ring]');
    const pct = li.querySelector('[data-pct]');
    const sp = li.querySelector('[data-speed]');
    if (ring) ring.setAttribute('stroke-dashoffset', C * (1 - frac(t)));
    if (pct) pct.textContent = Math.round(frac(t) * 100) + '%';
    if (sp) sp.textContent = speedText(t);
  }

  /* ---------- latest received: a one-line bar under the radar ---------- */
  const latest = $('latest');
  let latestSig = '';
  function newestIn() {
    for (const tid of order) {
      const t = engine.all.get(tid);
      if (t && t.dir === 'in' && t.status !== 'rejected') return t;
    }
    return null;
  }
  function renderLatest(force) {
    const t = newestIn();
    const sig = t ? [t.tid, sigOf(t), t.status === 'active' ? Math.round(frac(t) * 100) : ''].join('|') : '';
    if (sig === latestSig && !force) return;
    latestSig = sig;
    latest.hidden = !t;
    if (!t) { latest.innerHTML = ''; return; }
    const dev = presence.get(t.peer) || known.get(t.peer);
    const who = dev ? dev.name : tt('leftDevice');
    const when = new Date(t.created).toLocaleTimeString(getLang(), { hour: '2-digit', minute: '2-digit' });
    const body = t.kind === 'file' ? t.name : t.text != null ? t.text.replace(/\s+/g, ' ') : t.inline != null ? t.inline.replace(/\s+/g, ' ') : tt('item.text');
    let end = '';
    if (t.status === 'pending') end = `<button type="button" class="btn primary sm" data-act="accept" data-id="${t.tid}">${esc(tt('accept'))}</button>`;
    else if (t.status === 'active' || t.status === 'verifying') end = `<span class="lt-pct">${Math.round(frac(t) * 100)}%</span>`;
    else if (t.status === 'done' && t.kind === 'text') end = `<button type="button" class="btn ghost sm" data-act="copy" data-id="${t.tid}">${esc(tt('copy'))}</button>`;
    else if (t.status === 'done') end = `<button type="button" class="btn primary sm" data-act="save" data-id="${t.tid}">${esc(tt('save'))}</button>`;
    else if (t.status === 'failed' || t.status === 'canceled' || t.status === 'paused') end = `<span class="lt-pct">${esc(tt(t.status === 'failed' ? 'st.failed' : t.status === 'canceled' ? 'st.canceled' : 'st.pausedIn'))}</span>`;
    latest.dataset.id = t.tid;
    latest.innerHTML =
      `<div class="ico">${svg(t.kind === 'file' ? 'file' : 'text', 20)}</div>` +
      `<div class="meta"><div class="lt-head">${esc(tt('latest.from', { who }))} · ${esc(when)}</div><div class="lt-title">${esc(body)}</div></div>` +
      `<div class="end">${end}</div>`;
  }

  engine.addEventListener('update', (e) => {
    const t = e.detail;
    if (!order.includes(t.tid)) order.unshift(t.tid);
    if (rendered.get(t.tid) === sigOf(t)) patchProgress(t);
    else renderList();
    renderLatest();
    keepAwake();
  });

  function urlFor(t) {
    if (!t.url) t.url = URL.createObjectURL(t.file);
    return t.url;
  }
  function canShare(file) {
    const files = Array.isArray(file) ? file : [file];
    try { return !!(files.length && files.every(Boolean) && navigator.canShare && navigator.canShare({ files }) && /iPhone|iPad|Android/.test(navigator.userAgent)); } catch { return false; }
  }

  // Tapping the bar itself (not its button) jumps to that item in Activity.
  latest.addEventListener('click', (e) => {
    if (e.target.closest('[data-act]')) return;
    const li = list.querySelector(`[data-id="${latest.dataset.id}"]`);
    if (!li) return;
    li.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    li.classList.remove('flash');
    void li.offsetWidth;
    li.classList.add('flash');
  });

  async function onAct(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const t = engine.all.get(b.dataset.id);
    if (!t) return;
    const act = b.dataset.act;
    dlog('app', 'tap ' + act, { tid: t.tid.slice(0, 8) });
    if (act === 'accept') engine.accept(t);
    else if (act === 'decline') engine.reject(t);
    else if (act === 'cancel') engine.cancel(t);
    else if (act === 'save') {
      download(t);
      renderSaveAll();
    } else if (act === 'share') {
      try { await navigator.share({ files: [t.file] }); t.saved = true; renderSaveAll(); } catch {}
    } else if (act === 'copy') {
      const label = (s) => { b.textContent = tt(s); setTimeout(() => { b.textContent = tt('copy'); }, 1800); };
      try { await navigator.clipboard.writeText(t.text); label('copied'); } catch { label('copyFail'); }
    }
  }
  list.addEventListener('click', onAct);
  latest.addEventListener('click', onAct);

  function updateTitle() {
    const n = [...engine.all.values()].filter((t) => t.dir === 'in' && t.status === 'pending').length;
    document.title = n ? `(${n}) Softdrop` : 'Softdrop';
  }

  /* ---------- keep the screen on during transfers (iOS stops when the screen locks) ---------- */
  let wake = null;
  async function keepAwake() {
    const busy = engine.busy;
    if (busy && !wake && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      try {
        wake = await navigator.wakeLock.request('screen');
        dlog('app', 'wake lock on');
        wake.addEventListener('release', () => { wake = null; });
      } catch {}
    } else if (!busy && wake) {
      wake.release().catch(() => {});
      dlog('app', 'wake lock off');
      wake = null;
    }
  }
  document.addEventListener('visibilitychange', () => {
    dlog('app', 'page ' + document.visibilityState, { ws: sig.state, busy: engine.busy });
    if (document.visibilityState === 'visible') {
      sig.kick();
      engine.probeLinks();
      keepAwake();
    }
  });
  window.addEventListener('online', () => sig.kick());
  window.addEventListener('beforeunload', (e) => {
    if ([...engine.all.values()].some((t) => t.status === 'active')) { e.preventDefault(); e.returnValue = ''; }
  });

  /* ---------- pairing ---------- */
  const pairInput = $('pairInput');
  const pairBtn = $('pairBtn');
  const pairMsg = $('pairMsg');
  let codeTimer = null;
  // Pairing messages are kept as key + vars so they re-render in a new language.
  let pairMsgState = null;
  function setPairMsg(key, vars) {
    pairMsgState = key ? { key, vars } : null;
    pairMsg.textContent = key ? t(key, vars) : '';
  }
  let codeState = null; // { code, until } while a code is showing
  function renderPairSub() {
    const left = codeState ? Math.max(0, Math.round((codeState.until - Date.now()) / 1000)) : 0;
    if (!left) {
      codeState = null;
      clearInterval(codeTimer);
      $('pairSub').textContent = t('pair.sub');
      $('codeBtn').textContent = t('pair.getCode');
      return;
    }
    const mm = Math.floor(left / 60), ss = String(left % 60).padStart(2, '0');
    const c = codeState.code;
    // The template is plain text; the code is digits only, so it can be wrapped safely.
    $('pairSub').innerHTML = esc(t('pair.yourCode', { code: '\u0000', time: `${mm}:${ss}` }))
      .replace('\u0000', `<span class="code">${c}</span>`);
    $('codeBtn').textContent = t('pair.newCode');
  }
  function resetCode() {
    codeState = null;
    renderPairSub();
  }

  $('codeBtn').addEventListener('click', () => {
    if (sig.state !== 'open') { setPairMsg('pair.notReady'); return; }
    sig.send({ t: 'pair-create' });
  });
  sig.addEventListener('pair-code', (e) => {
    const { code, ttl } = e.detail;
    codeState = { code, until: Date.now() + ttl * 1000 };
    clearInterval(codeTimer);
    renderPairSub();
    codeTimer = setInterval(renderPairSub, 1000);
    setPairMsg(null);
  });
  pairInput.addEventListener('input', () => {
    const digits = pairInput.value.replace(/\D/g, '').slice(0, 4);
    pairInput.value = digits;
    pairBtn.disabled = digits.length !== 4;
  });
  $('pairForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const digits = pairInput.value.replace(/\D/g, '');
    if (digits.length !== 4) return;
    if (sig.state !== 'open') { setPairMsg('pair.notReady'); return; }
    setPairMsg('pair.pairing');
    sig.send({ t: 'pair-join', code: digits });
  });
  sig.addEventListener('error', (e) => {
    const { code, msg } = e.detail;
    if (['bad-code', 'own-code', 'rate-limited'].includes(code)) setPairMsg('err.' + code);
  });

  // A working code is enough: the other device is trusted straight away, without a check number.
  sig.addEventListener('paired', async (e) => {
    const p = e.detail.peer;
    if ((await idForPub(p.pub)) !== p.id) { setPairMsg('pair.badSecurity'); return; }
    clearInterval(codeTimer);
    resetCode();
    sig.send({ t: 'pair-cancel' });
    pairInput.value = '';
    pairBtn.disabled = true;
    await me.trust(p);
    known.set(p.id, { ...p, icon: iconForKind(p.kind) });
    sig.send({ t: 'links', ids: Object.keys(me.trusted) });
    dlog('app', 'paired', { peer: p.id.slice(0, 8) });
    setPairMsg('pair.done', { name: p.name });
    renderPaired();
    renderRadar();
  });

  function renderPaired() {
    const items = Object.values(me.trusted);
    $('pairedList').innerHTML = items.map((p) =>
      `<li><span class="on${presence.has(p.id) ? ' yes' : ''}" aria-hidden="true"></span>${esc(p.name)} <span class="muted">${esc(p.kind)}</span>` +
      `<button type="button" class="chip-x" data-forget="${esc(p.id)}" aria-label="${esc(t('pair.forget', { name: p.name }))}" title="${esc(t('pair.forgetTitle'))}">${svg('x', 14)}</button></li>`).join('');
  }
  $('pairedList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-forget]');
    if (!b) return;
    const p = me.trusted[b.dataset.forget];
    await me.forget(b.dataset.forget);
    sig.send({ t: 'links', ids: Object.keys(me.trusted) });
    setPairMsg(p ? 'pair.forgot' : null, p ? { name: p.name } : undefined);
    renderPaired();
    renderRadar();
  });

  /* ---------- install as an app ---------- */
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  let dismissed = false;
  try { dismissed = localStorage.getItem('softdrop-install-dismissed') === '1'; } catch {}
  let deferredPrompt = null;
  const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  if (!standalone && !dismissed && isIos) {
    $('installText').dataset.i18n = 'install.ios';
    applyStatic($('install'));
    $('install').hidden = false;
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    if (dismissed) return;
    deferredPrompt = e;
    $('installText').dataset.i18n = 'install.app';
    applyStatic($('install'));
    $('installBtn').hidden = false;
    $('install').hidden = false;
  });
  $('installBtn').addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice.catch(() => {});
    deferredPrompt = null;
    $('install').hidden = true;
  });
  $('installX').addEventListener('click', () => {
    $('install').hidden = true;
    try { localStorage.setItem('softdrop-install-dismissed', '1'); } catch {}
  });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch((e) => console.warn('softdrop: service worker', e));

  /* ---------- go ---------- */
  function renderAll() {
    autoSelect();
    renderRadar();
    renderTo();
    updateSend();
    renderPaired();
  }
  renderAll();
  renderStaged();
  renderList();
  renderPairSub();
  onLangChange(() => {
    renderAll();
    renderStaged();
    renderList();
    renderLatest(true);
    renderPairSub();
    if (pairMsgState) pairMsg.textContent = t(pairMsgState.key, pairMsgState.vars);
  });
  setupDebugPanel(sig);
  sig.start();

  // Handy for debugging from the console. Nothing here leaves the page.
  window.softdrop = { me, sig, peers, engine, presence };
}

/* ---------- debug log panel (?debug=1) ---------- */
function setupDebugPanel(sig) {
  if (!debugOn()) return;
  const panel = $('debugPanel');
  const pre = $('debugLines');
  // Logs are always recorded and sent to the server; the panel only shows with ?debug=1.
  panel.hidden = new URLSearchParams(location.search).get('debug') !== '1';
  pre.textContent = allLines().join('\n');
  let stick = true;
  pre.addEventListener('scroll', () => { stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8; });
  onLine((line) => {
    pre.textContent += (pre.textContent ? '\n' : '') + line;
    if (pre.textContent.length > 200000) pre.textContent = pre.textContent.slice(-150000);
    if (stick) pre.scrollTop = pre.scrollHeight;
  });
  $('debugCopy').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    try { await navigator.clipboard.writeText(allLines().join('\n')); b.textContent = t('copied'); } catch { b.textContent = t('copyFail'); }
    setTimeout(() => { b.textContent = t('debug.copy'); }, 1600);
  });
  $('debugClear').addEventListener('click', () => { clearLines(); pre.textContent = ''; });
  $('debugToggle').addEventListener('click', () => {
    const hide = !pre.hidden;
    pre.hidden = hide;
    $('debugToggle').dataset.i18n = hide ? 'debug.show' : 'debug.hide';
    applyStatic(panel);
  });
  sendRemote((lines) => {
    if (sig.state !== 'open') return false;
    sig.raw({ t: 'log', lines });
    return true;
  });
  setTimeout(() => { pre.scrollTop = pre.scrollHeight; }, 0);
}
