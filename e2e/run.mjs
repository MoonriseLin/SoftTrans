// End-to-end check: two isolated browser profiles, real server, real WebRTC.
// Local:      npm i && npx playwright-core install chromium-headless-shell && node run.mjs
// Production: BASE=https://mio.pantsu.uk node run.mjs
// Via TURN:   QUERY='?relay=1' WANT_ROUTE=relay WANT_LABEL='Via relay' BASE=... node run.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:18480';
let srv = null;
if (!process.env.BASE) {
  srv = spawn('node', [new URL('../server/src/index.js', import.meta.url).pathname], { env: { ...process.env, PORT: '18480' }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', (d) => process.env.V && process.stdout.write('[srv] ' + d));
  srv.stderr.on('data', (d) => process.stdout.write('[srv!] ' + d));
  await new Promise((r) => setTimeout(r, 700));
}

const browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns', ...(process.env.ARGS ? process.env.ARGS.split(' ') : [])] });
const errors = [];
async function open(label) {
  const ctx = await browser.newContext({ acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${label}] ${m.text()} @ ${m.location().url}`); });
  page.on('requestfailed', (r) => errors.push(`[${label}] requestfailed ${r.url()} ${r.failure()?.errorText}`));
  page.on('pageerror', (e) => errors.push(`[${label}] pageerror ${e.message}`));
  await page.goto(BASE + '/' + (process.env.QUERY || ''));
  await page.waitForFunction(() => window.softdrop && window.softdrop.sig.state === 'open', null, { timeout: 15000 });
  return page;
}
const step = (s) => console.log('•', s);
let failed = false;
const check = (cond, msg) => { console.log(cond ? '  ✓' : '  ✗', msg); if (!cond) failed = true; };

try {
  const a = await open('A');
  const b = await open('B');
  const idA = await a.evaluate(() => softdrop.me.id);
  const idB = await b.evaluate(() => softdrop.me.id);
  step('presence');
  await a.waitForSelector(`.device[data-id="${idB}"]`, { timeout: 5000 });
  await b.waitForSelector(`.device[data-id="${idA}"]`, { timeout: 5000 });
  check(true, 'both devices appear on each other\'s radar');

  step('text transfer');
  await a.waitForSelector(`.device[data-id="${idB}"][aria-pressed="true"]`, { timeout: 5000 });
  check(true, 'the only nearby device is selected without a tap');
  await a.waitForFunction((id) => softdrop.peers.links.get(id)?.state === 'open', idB, { timeout: 15000 });
  await a.waitForFunction((id) => softdrop.peers.links.get(id).route, idB, { timeout: 5000 });
  const route = await a.evaluate((id) => softdrop.peers.links.get(id).route, idB);
  check(route === (process.env.WANT_ROUTE || 'lan'), `route detected as ${route}`);
  const toText = await a.textContent('#to');
  check(toText.includes(process.env.WANT_LABEL || 'Direct · same Wi-Fi'), `send card shows "${toText.trim()}"`);
  await a.fill('#text', 'Meet at the east gate at 6 🌸');
  await a.click('#send');
  await b.waitForSelector('[data-act="accept"]', { timeout: 5000 });
  check((await b.title()).startsWith('(1)'), 'unpaired sender: receiver is asked first');
  await b.click('#list [data-act="accept"]');
  await b.waitForSelector('.preview', { timeout: 5000 });
  check((await b.textContent('.preview')) === 'Meet at the east gate at 6 🌸', 'receiver shows the text');
  await a.waitForFunction(() => document.querySelector('.done')?.textContent.includes('Sent'), null, { timeout: 5000 });
  check(true, 'sender shows Sent');
  check(await b.isHidden('#debugPanel'), 'log panel hidden without ?debug=1');
  check(/east gate/.test(await b.textContent('#latest .lt-title')), 'latest-received bar shows the text');
  const sections = await b.$$eval('main > section:not([hidden])', (els) => els.map((e) => e.id || e.className || e.getAttribute('aria-labelledby')));
  check(sections.join(',') === 'nearbyTitle,latest,sendTitle,actTitle,pair', `section order ${sections.join(',')}`);

  step('paste button');
  await a.evaluate(() => navigator.clipboard.writeText('from the clipboard'));
  await a.fill('#text', '');
  await a.click('#pasteBtn');
  await a.waitForFunction(() => document.getElementById('text').value !== '', null, { timeout: 3000 }).catch(() => {});
  const pasted = await a.inputValue('#text');
  check(pasted === 'from the clipboard', `Paste puts clipboard text in the box ("${pasted}")`);
  await a.fill('#text', '');

  for (const size of [0, 70000, 12 * 1024 * 1024 + 7]) {
    step(`file transfer, ${size} bytes`);
    const data = randomBytes(size);
    const want = createHash('sha256').update(data).digest('hex');
    await a.setInputFiles('#fileInput', { name: `blob-${size}.bin`, mimeType: 'application/octet-stream', buffer: data });
    await a.click('#send');
    await b.waitForSelector('#list [data-act="accept"]', { timeout: 5000 });
    const t0 = Date.now();
    await b.click('#list [data-act="accept"]');
    await b.waitForFunction((n) => [...softdrop.engine.all.values()].some((t) => t.name === n && t.status === 'done'), `blob-${size}.bin`, { timeout: 60000 });
    const secs = (Date.now() - t0) / 1000;
    const got = await b.evaluate(async (n) => {
      const t = [...softdrop.engine.all.values()].find((x) => x.name === n);
      const buf = new Uint8Array(await t.file.arrayBuffer());
      const h = await crypto.subtle.digest('SHA-256', buf);
      return { hex: Array.from(new Uint8Array(h), (x) => x.toString(16).padStart(2, '0')).join(''), size: buf.length };
    }, `blob-${size}.bin`);
    check(got.hex === want && got.size === size, `received bytes match (${(size / 1e6 / secs).toFixed(1)} MB/s)`);
    const [dl] = await Promise.all([b.waitForEvent('download'), b.click(`.item:has-text("blob-${size}.bin") [data-act="save"]`)]);
    const p = await dl.path();
    check(fs.statSync(p).size === size, 'Save downloads the file');
  }

  step('cancel mid-transfer');
  const big = randomBytes(40 * 1024 * 1024);
  await a.setInputFiles('#fileInput', { name: 'big.bin', mimeType: 'application/octet-stream', buffer: big });
  await a.click('#send');
  await b.waitForSelector('#list [data-act="accept"]', { timeout: 5000 });
  await b.click('#list [data-act="accept"]');
  await a.waitForFunction(() => [...softdrop.engine.all.values()].some((t) => t.name === 'big.bin' && t.done > 0), null, { timeout: 10000 });
  const prog = await a.textContent('.item:has-text("big.bin") [data-speed]');
  check(/^[\d.]+ (KB|MB) \/ 41\.9 MB/.test(prog), `progress shows sizes: "${prog}"`);
  const subLine = await a.textContent('.item:has-text("big.bin") .sub');
  check(!/MB/.test(subLine), `size not repeated next to the device while sending: "${subLine}"`);
  await a.click('.item:has-text("big.bin") [data-act="cancel"]');
  await b.waitForFunction(() => [...softdrop.engine.all.values()].some((t) => t.name === 'big.bin' && t.status === 'canceled'), null, { timeout: 5000 });
  check(true, 'receiver sees the cancel');

  step('pairing by code');
  await a.click('#codeBtn');
  await a.waitForSelector('#pairSub .code');
  const code = (await a.textContent('#pairSub .code')).replace(/\D/g, '');
  check(/^\d{4}$/.test(code), `4-digit code ${code}`);
  await b.fill('#pairInput', code);
  await b.click('#pairBtn');
  await a.waitForFunction((id) => softdrop.me.isTrusted(id), idB);
  await b.waitForFunction((id) => softdrop.me.isTrusted(id), idA);
  check(true, 'paired on both sides without a confirm step');
  check(await a.isVisible(`.device[data-id="${idB}"] .badge`), 'paired badge on the radar');
  await b.fill('#pairInput', code);
  await b.click('#pairBtn');
  await b.waitForFunction(() => /did not work/.test(document.getElementById('pairMsg').textContent));
  check(true, 'code is single use');

  step('pairing by scanning the QR code');
  await a.click('#codeBtn');
  await a.waitForFunction(() => !document.getElementById('pairQr').hidden && document.getElementById('pairQr').dataset.code);
  const qrCode = await a.$eval('#pairQr', (e) => e.dataset.code);
  check(/^\d{4}$/.test(qrCode) && (await a.isVisible('#qrImg svg path')), `QR shown for code ${qrCode}`);
  const cctx = await browser.newContext();
  const c = await cctx.newPage();
  await c.goto(BASE + '/#pair=' + qrCode);
  await c.waitForFunction(() => window.softdrop && softdrop.sig.state === 'open');
  const idC = await c.evaluate(() => softdrop.me.id);
  await a.waitForFunction((id) => softdrop.me.isTrusted(id), idC, { timeout: 10000 });
  await c.waitForFunction((id) => softdrop.me.isTrusted(id), idA, { timeout: 10000 });
  check(true, 'opening the QR link pairs both devices');
  check(!(await c.evaluate(() => location.hash)), 'code removed from the address');
  check(await a.isHidden('#pairQr'), 'QR hidden once used');
  await cctx.close();

  step('reload keeps identity and trust');
  await b.reload();
  await b.waitForFunction(() => window.softdrop && softdrop.sig.state === 'open');
  check((await b.evaluate(() => softdrop.me.id)) === idB, 'same device id after reload');
  check(await b.evaluate((id) => softdrop.me.isTrusted(id), idA), 'still paired after reload');
  await b.waitForSelector(`.device[data-id="${idA}"]`);

  step('transfer after the receiver reloaded (fresh connection)');
  await a.fill('#text', 'after reload');
  await a.click('#send');
  await b.waitForFunction(() => [...document.querySelectorAll('.preview')].some((x) => x.textContent === 'after reload'), null, { timeout: 20000 });
  check(true, 'text arrives on the new connection');
  check(!(await b.$('#list [data-act="accept"]')), 'paired sender: no Accept step');

  step('save all');
  await a.setInputFiles('#fileInput', [
    { name: 'one.txt', mimeType: 'text/plain', buffer: Buffer.from('first file') },
    { name: 'two.txt', mimeType: 'text/plain', buffer: Buffer.from('second file') },
  ]);
  await a.click('#send');
  await b.waitForFunction(() => ['one.txt', 'two.txt'].every((n) => [...softdrop.engine.all.values()].some((t) => t.name === n && t.status === 'done')), null, { timeout: 10000 });
  await b.waitForSelector('#saveAll:not([hidden])');
  check((await b.textContent('#saveAll')) === 'Save all (2)', 'Save all (2) appears');
  const dls = [];
  b.on('download', (d) => dls.push(d.suggestedFilename()));
  await b.click('#saveAll');
  await b.waitForFunction(() => document.getElementById('saveAll').hidden, null, { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 500));
  check(dls.sort().join(',') === 'one.txt,two.txt', `Save all downloads both (${dls.join(',')})`);

  step('a dropped connection reconnects and the transfer resumes');
  const mid = randomBytes(24 * 1024 * 1024);
  const midHash = createHash('sha256').update(mid).digest('hex');
  await a.setInputFiles('#fileInput', { name: 'mid.bin', mimeType: 'application/octet-stream', buffer: mid });
  await a.click('#send');
  await b.waitForFunction(() => [...softdrop.engine.all.values()].some((t) => t.name === 'mid.bin' && t.done > 4e6), null, { timeout: 30000 });
  await a.evaluate((id) => softdrop.peers.links.get(id).lost('test: connection dropped'), idB);
  await a.waitForFunction(() => [...softdrop.engine.all.values()].some((t) => t.name === 'mid.bin' && t.status === 'paused'), null, { timeout: 5000 });
  check(true, 'transfer paused when the connection dropped');
  await b.waitForFunction(() => [...softdrop.engine.all.values()].some((t) => t.name === 'mid.bin' && t.status === 'done'), null, { timeout: 60000 });
  const midGot = await b.evaluate(async () => {
    const t = [...softdrop.engine.all.values()].find((x) => x.name === 'mid.bin');
    const h = await crypto.subtle.digest('SHA-256', await t.file.arrayBuffer());
    return Array.from(new Uint8Array(h), (x) => x.toString(16).padStart(2, '0')).join('');
  });
  check(midGot === midHash, 'reconnected by itself and finished with the right bytes');

  const bLog = [];
  b.on('console', (m) => bLog.push(m.text()));
  const hashIn = (n) => b.evaluate(async (name) => {
    const t = [...softdrop.engine.all.values()].find((x) => x.name === name && x.status === 'done');
    const h = await crypto.subtle.digest('SHA-256', await t.file.arrayBuffer());
    return Array.from(new Uint8Array(h), (x) => x.toString(16).padStart(2, '0')).join('');
  }, n);

  step('the receiving page is reloaded mid-transfer');
  const rl = randomBytes(48 * 1024 * 1024);
  const rlHash = createHash('sha256').update(rl).digest('hex');
  await a.setInputFiles('#fileInput', { name: 'reload-rx.bin', mimeType: 'application/octet-stream', buffer: rl });
  await a.click('#send');
  await b.waitForFunction(() => [...softdrop.engine.all.values()].some((t) => t.name === 'reload-rx.bin' && t.done > 36 * 1024 * 1024), null, { timeout: 60000 });
  await b.reload();
  await b.waitForFunction(() => window.softdrop && softdrop.sig.state === 'open');
  await b.waitForFunction(() => [...softdrop.engine.all.values()].some((t) => t.name === 'reload-rx.bin' && t.status === 'done'), null, { timeout: 90000 });
  const revived = bLog.find((l) => /in revived after reload/.test(l)) || '';
  const from = Number((revived.match(/from=(\d+)/) || [])[1] || 0);
  check(from >= 16 * 1024 * 1024, `resumed after the reload from ${(from / 1e6).toFixed(1)} MB, not from zero`);
  check((await hashIn('reload-rx.bin')) === rlHash, 'file complete and correct after the receiver reloaded');

  step('the sending page is reloaded, then the same file is sent again');
  const sx = randomBytes(40 * 1024 * 1024);
  const sxHash = createHash('sha256').update(sx).digest('hex');
  await a.setInputFiles('#fileInput', { name: 'reload-tx.bin', mimeType: 'application/octet-stream', buffer: sx });
  await a.click('#send');
  await b.waitForFunction(() => [...softdrop.engine.all.values()].some((t) => t.name === 'reload-tx.bin' && t.done > 20 * 1024 * 1024), null, { timeout: 60000 });
  await a.reload();
  await a.waitForFunction(() => window.softdrop && softdrop.sig.state === 'open');
  await a.waitForSelector(`.device[data-id="${idB}"][aria-pressed="true"]`, { timeout: 10000 });
  await a.setInputFiles('#fileInput', { name: 'reload-tx.bin', mimeType: 'application/octet-stream', buffer: sx });
  await a.click('#send');
  await b.waitForFunction(() => [...softdrop.engine.all.values()].some((t) => t.name === 'reload-tx.bin' && t.status === 'done'), null, { timeout: 90000 });
  check(bLog.some((l) => /same file offered again: resuming/.test(l)), 'receiver continued the old partial file');
  check((await hashIn('reload-tx.bin')) === sxHash, 'file complete and correct after the sender reloaded');
  check((await b.$$eval('#list .item', (els) => els.filter((e) => e.textContent.includes('reload-tx.bin')).length)) === 1, 'one Activity item for the resumed file');

  step('a silent link is dropped when the page comes back');
  await b.evaluate(() => { const e = softdrop.engine, orig = e.ctl; e.ctl = (l, m) => (m.t === 'pong' ? undefined : orig.call(e, l, m)); });
  await a.evaluate(() => softdrop.engine.probeLinks());
  await a.waitForFunction((id) => softdrop.peers.links.get(id).state !== 'open', idB, { timeout: 6000 });
  check(true, 'no answer to the ping closes the link');
  await b.evaluate(() => { delete softdrop.engine.ctl; });
  await a.evaluate((id) => softdrop.peers.get(id).ready(), idB);

  step('activity list');
  const ids = await a.$$eval('.list .item', (els) => els.map((e) => e.dataset.id));
  // The sender page was reloaded in the reload test, so only the resent file is listed since then.
  check(ids.length === new Set(ids).size && ids.length === 1, `sender lists each transfer once (${ids.length} items)`);

  step('language');
  const langOf = (p) => p.evaluate(() => ({ html: document.documentElement.lang, send: document.getElementById('send').textContent, nearby: document.getElementById('nearbyTitle').textContent, ph: document.getElementById('text').placeholder, stored: localStorage.getItem('softdrop-lang') }));
  check((await langOf(a)).html === 'en', 'starts in English for an English browser');
  await a.selectOption('#langSel', 'ja');
  let L = await langOf(a);
  check(L.html === 'ja' && L.send === '送信' && L.nearby === '近くのデバイス' && L.ph.includes('ドロップ'), `Japanese applied (${L.nearby} / ${L.send})`);
  const jaRoute = { lan: '直接 · 同じ Wi-Fi', direct: '直接', relay: 'リレー経由' }[process.env.WANT_ROUTE || 'lan'];
  check((await a.textContent('#to')).includes(jaRoute), `route label translated (${jaRoute})`);
  check((await a.textContent('.list .item .done')).includes('送信しました'), 'activity list translated');
  await a.reload();
  await a.waitForFunction(() => window.softdrop && softdrop.sig.state === 'open');
  L = await langOf(a);
  check(L.html === 'ja' && L.stored === 'ja' && (await a.inputValue('#langSel')) === 'ja', 'Japanese remembered after reload');
  await a.selectOption('#langSel', 'zh-Hant');
  L = await langOf(a);
  check(L.html === 'zh-Hant' && L.send === '傳送' && L.nearby === '附近', `Traditional Chinese applied (${L.send})`);
  await a.selectOption('#langSel', 'zh');
  L = await langOf(a);
  check(L.html === 'zh-Hans' && L.send === '发送', `Simplified Chinese applied (${L.send})`);
  const ctxJa = await browser.newContext({ locale: 'ja-JP' });
  const pj = await ctxJa.newPage();
  await pj.goto(BASE + '/');
  await pj.waitForFunction(() => window.softdrop);
  check((await pj.evaluate(() => document.documentElement.lang)) === 'ja', 'first visit follows a Japanese browser');
  const ctxTw = await browser.newContext({ locale: 'zh-TW' });
  const pt = await ctxTw.newPage();
  await pt.goto(BASE + '/');
  await pt.waitForFunction(() => window.softdrop);
  check((await pt.evaluate(() => document.documentElement.lang)) === 'zh-Hant', 'first visit follows a zh-TW browser');
  if (process.env.SHOT) await pj.screenshot({ path: process.env.SHOT + '-ja.png', fullPage: true });
  await ctxJa.close();
  await ctxTw.close();
  await a.selectOption('#langSel', 'en');

  step('theme toggle');
  await a.click('#themeBtn');
  check((await a.getAttribute('html', 'data-theme')) === 'light', 'light');
  await a.click('#themeBtn');
  check((await a.getAttribute('html', 'data-theme')) === 'dark', 'dark');

  if (process.env.SHOT) {
    await a.setViewportSize({ width: 390, height: 1300 });
    await a.screenshot({ path: process.env.SHOT + '-a-dark.png', fullPage: true });
    await a.click('#themeBtn');
    await b.setViewportSize({ width: 390, height: 1300 });
    await b.screenshot({ path: process.env.SHOT + '-b-system.png', fullPage: true });
  }
} catch (e) {
  failed = true;
  console.log('✗ exception:', e.message.split('\n').slice(0, 4).join('\n'));
} finally {
  const relevant = errors.filter((e) => !/fonts\.g/.test(e));
  if (relevant.length) console.log('console:\n  ' + relevant.slice(0, 20).join('\n  '));
  await browser.close();
  if (srv) srv.kill();
  console.log(failed ? 'FAILED' : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
}
