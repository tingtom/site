// Regression guard for the rotation plumbing: the saved/queried rotation has
// to actually reach the three.js object, which is the thing that silently
// failed when the presets could not express the angle.
//
// Checks, against a live page:
//   1. window.__model exists and reports a rotation line
//   2. ?rot= changes the rendered silhouette (so the field is not ignored)
//   3. ?rotate hands the drag over without throwing
const { spawn } = await import('node:child_process');
const { execFileSync } = await import('node:child_process');
const sharp = (await import('sharp')).default;
import { rmSync, existsSync, statSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:4399/site';
const PAGE = `${BASE}/rx7/models/fd3s-headlight-covers/`;
const PORT = 9444;
const RAD = Math.PI / 180;

function cdp() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/devtools/page/PLACEHOLDER`);
    ws.onerror = reject;
    ws.onopen = () => resolve(ws);
  });
}

// --- 1 & 3: evaluate JS in the page ---------------------------------------
const chrome = spawn(
  '/usr/bin/chromium',
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader',
    '--hide-scrollbars',
    '--window-size=1600,1000',
    `--remote-debugging-port=${PORT}`,
    'about:blank',
  ],
  { stdio: 'ignore', detached: true },
);
chrome.unref();

let list;
for (let i = 0; i < 40; i++) {
  try {
    list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    if (list.some((t) => t.type === 'page')) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 250));
}
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result);
  }
};
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });

const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'evaluate failed');
  return r.result.value;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 1600,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
});

console.log('1. console handle');
await send('Page.navigate', { url: PAGE });
await sleep(9000);
const line = await evalJs(`window.__model ? __model.line() : null`);
check('__model exists and line() returns a rotation', typeof line === 'string' && line.startsWith('rotation:'), line);
const bakeOk = await evalJs(`(() => { try { __model.bake(); return __model.line(); } catch (e) { return 'THREW: ' + e.message; } })()`);
check('bake() folds the preset without throwing', String(bakeOk).startsWith('rotation:'), String(bakeOk));
const dragOk = await evalJs(`(() => { try { __model.enableDrag(); return 'enabled'; } catch (e) { return 'THREW: ' + e.message; } })()`);
check('enableDrag() wires up without throwing', dragOk === 'enabled', String(dragOk));

console.log('2. ?rot= reaches the model (render + compare silhouette)');
async function silhouette(rot) {
  const out = `/tmp/opencode/guard-${(rot || 'none').replace(/,/g, '_')}.png`;
  rmSync(out, { force: true });
  execFileSync(
    '/usr/bin/chromium',
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader',
      '--hide-scrollbars',
      '--window-size=1600,1000',
      '--virtual-time-budget=12000',
      `--screenshot=${out}`,
      rot ? `${PAGE}?render=1&rot=${rot}` : `${PAGE}?render=1`,
    ],
    { stdio: 'ignore', timeout: 90_000 },
  );
  const { data, info } = await sharp(out).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;
  let minX = W, maxX = 0, minY = H, maxY = 0, lit = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * C;
      if (Math.max(data[i], data[i + 1], data[i + 2]) > 95) {
        lit++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  return { w: maxX - minX, h: maxY - minY, lit };
}

const a = await silhouette(null);
const b = await silhouette('0,90,0');
check('a render with no rotation differs from ?rot=0,90,0', a.w !== b.w || a.h !== b.h, `default ${a.w}×${a.h} vs rotated ${b.w}×${b.h}`);
check('both renders contain the model', a.lit > 5000 && b.lit > 5000, `lit ${a.lit} / ${b.lit}`);

console.log('3. ?rotate mode');
await send('Page.navigate', { url: `${PAGE}?rotate=1` });
await sleep(9000);
const rotateOk = await evalJs(
  `window.__model ? (typeof __model.enableDrag === 'function' ? 'ok' : 'no method') : 'no __model'`,
);
check('?rotate exposes the same handle', rotateOk === 'ok', String(rotateOk));
const errors = await evalJs(`window.__rotateErrors || 0`);
check('no page errors in ?rotate mode', errors === 0, String(errors));

ws.close();
try {
  process.kill(-chrome.pid, 'SIGKILL');
} catch {
  /* already gone */
}

console.log(failures === 0 ? '\nALL CHECKS PASS' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures ? 1 : 0);
