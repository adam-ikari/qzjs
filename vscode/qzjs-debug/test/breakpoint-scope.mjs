// End-to-end: setBreakpoints is scoped per source file.
//
// VS Code sends one setBreakpoints request per source whenever that source's
// breakpoints change. The handler must replace ONLY that file's breakpoints —
// the old implementation cleared the whole table first, so toggling
// breakpoints in any other file silently wiped this file's breakpoints
// (reported verified, never hit).
//
// Flow — two real sources plus one never-loaded file that is set then cleared:
//   1. setBreakpoints(SRC,    [line 3])   inside f()
//   2. setBreakpoints(HELPER, [line 1])   helper's only line (real file name
//                                         via __native__.nativeEvalScript)
//   3. setBreakpoints(OTHER,  [line 1])   other file, never loads
//   4. setBreakpoints(OTHER,  [])         clear OTHER only
// After configurationDone: entry stop → SRC:3 → HELPER:1 → terminated.
// Under whole-table clearing, step 3 (or 4) wipes 1+2 and neither breakpoint
// ever hits.
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { QzjsDebugSession } from '../out/adapter/qzjsDebugSession.js';

function connect(session) {
  const toAdapter = new EventEmitter();
  const toClient = new EventEmitter();
  session.onDidSendMessage((msg) => toClient.emit('msg', msg));
  toAdapter.on('msg', (msg) => session.handleMessage(msg));
  return { toAdapter, toClient };
}

const SRC = '/tmp/dap_scope_app.js';
const HELPER = '/tmp/dap_scope_helper.js';
const OTHER = '/tmp/dap_scope_other.js'; // never loaded — only its requests matter
const SRC_BP_LINE = 3; // `return y;`
const HELPER_BP_LINE = 1; // `const h = 1;`

const cfg = {
  type: 'qzjs',
  request: 'launch',
  name: 'breakpoint-scope',
  program: SRC,
  runtimeExecutable:
    process.env.QZJS_RUNTIME ||
    fileURLToPath(new URL('../../../build_dbg/qzjs', import.meta.url)),
  runtimeArgs: [],
  env: {},
};

const { toAdapter, toClient } = connect(new QzjsDebugSession(cfg));
let seq = 0;
const pending = new Map();
const events = [];
toClient.on('msg', (msg) => {
  if (msg.type === 'response' && msg.request_seq) {
    const p = pending.get(msg.request_seq);
    if (p) { pending.delete(msg.request_seq); p(msg); }
  } else if (msg.type === 'event') {
    events.push(msg);
  }
});
function send(cmd, args = {}) {
  return new Promise((resolve, reject) => {
    const s = ++seq;
    pending.set(s, resolve);
    setTimeout(() => reject(new Error('timeout ' + cmd)), 10000);
    toAdapter.emit('msg', { type: 'request', seq: s, command: cmd, arguments: args });
  });
}

const stoppedEvents = () => events.filter((e) => e.event === 'stopped');
async function waitStopped(n, ms = 6000) {
  const t0 = Date.now();
  while (stoppedEvents().length < n && Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return stoppedEvents().length;
}
async function waitEvent(name, ms = 6000) {
  const t0 = Date.now();
  while (!events.some((e) => e.event === name) && Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return events.some((e) => e.event === name);
}

const src = [
  'function f(x) {',
  '  let y = x * 2;',
  '  return y;',
  '}',
  'const r = f(21);',
  // Eval a second source under its own real file name: a breakpoint set on
  // HELPER must fire when this runs. (No module loader in qzjs; this is the
  // supported way to get a second real filename on a frame.)
  '__native__.nativeEvalScript("const h = 1;\\nif (h) { h; }", "' + HELPER + '");',
  'console.log("result", r);',
  '',
].join('\n');
writeFileSync(SRC, src);

let failed = 0;
const fail = (msg) => { failed++; console.log('FAIL: ' + msg); };

await send('initialize', { adapterID: 'qzjs', clientID: 'scope', pathFormat: 'path' });

const r1 = await send('setBreakpoints', {
  source: { path: SRC },
  breakpoints: [{ line: SRC_BP_LINE }],
});
const v1 = r1.body?.breakpoints?.[0];
if (v1?.verified !== true) fail(`SRC breakpoint not verified: ${JSON.stringify(r1.body)}`);

const r2 = await send('setBreakpoints', {
  source: { path: HELPER },
  breakpoints: [{ line: HELPER_BP_LINE }],
});
const v2 = r2.body?.breakpoints?.[0];
if (v2?.verified !== true) fail(`HELPER breakpoint not verified: ${JSON.stringify(r2.body)}`);

// OTHER is set, then cleared — under whole-table clearing either request
// wipes SRC + HELPER.
await send('setBreakpoints', {
  source: { path: OTHER },
  breakpoints: [{ line: 1 }],
});
const r4 = await send('setBreakpoints', {
  source: { path: OTHER },
  breakpoints: [],
});
if (Array.isArray(r4.body?.breakpoints) && r4.body.breakpoints.length !== 0) {
  fail(`clearing OTHER echoed back breakpoints: ${JSON.stringify(r4.body)}`);
}

await send('configurationDone');

// 1) pause at entry
const n1 = await waitStopped(1);
if (n1 < 1) fail('no entry stop');
console.log('stopped after configuration:', n1);

// 2) continue → the SRC breakpoint must survive OTHER's set/clear
await send('continue', { threadId: 1 });
const n2 = await waitStopped(2);
console.log('stopped after continue:', n2);
if (n2 < 2) {
  fail(
    `SRC breakpoint wiped by another file's setBreakpoints (stops=${n2}, ` +
      `reasons=${stoppedEvents().map((e) => e.body?.reason).join(',')})`,
  );
} else {
  const st = await send('stackTrace', { threadId: 1, startFrame: 0, levels: 20 });
  const top = st.body?.stackFrames?.[0];
  console.log('stop 2:', stoppedEvents()[1].body?.reason, top?.source?.path, top?.line);
  if (stoppedEvents()[1].body?.reason !== 'breakpoint') fail('stop 2 is not a breakpoint');
  if (top?.source?.path !== SRC) fail(`stop 2 path ${top?.source?.path} !== ${SRC}`);
  if (top?.line !== SRC_BP_LINE) fail(`stop 2 line ${top?.line} !== ${SRC_BP_LINE}`);

  // 3) continue → the HELPER breakpoint (a different file) must also fire
  await send('continue', { threadId: 1 });
  const n3 = await waitStopped(3);
  console.log('stopped after second continue:', n3);
  if (n3 < 3) {
    fail(
      `HELPER breakpoint never hit (stops=${n3}, reasons=${stoppedEvents()
        .map((e) => e.body?.reason)
        .join(',')})`,
    );
  } else {
    const st3 = await send('stackTrace', { threadId: 1, startFrame: 0, levels: 20 });
    const top3 = st3.body?.stackFrames?.[0];
    console.log('stop 3:', stoppedEvents()[2].body?.reason, top3?.source?.path, top3?.line);
    if (stoppedEvents()[2].body?.reason !== 'breakpoint') fail('stop 3 is not a breakpoint');
    if (top3?.source?.path !== HELPER) fail(`stop 3 path ${top3?.source?.path} !== ${HELPER}`);
    if (top3?.line !== HELPER_BP_LINE) fail(`stop 3 line ${top3?.line} !== ${HELPER_BP_LINE}`);
  }
}

// 4) run to completion → terminated (a terminated debuggee may already have
// made the adapter drop further continue requests — that's not a failure here,
// steps 1-3 carry the assertions).
try { await send('continue', { threadId: 1 }); } catch { /* already done */ }
const terminated = await waitEvent('terminated');
console.log('events:', events.map((e) => e.event).join(','));
if (!terminated) fail('no terminated event');
console.log(failed === 0 ? 'BREAKPOINT-SCOPE PASS' : 'BREAKPOINT-SCOPE FAIL');
process.exit(failed === 0 ? 0 : 1);
