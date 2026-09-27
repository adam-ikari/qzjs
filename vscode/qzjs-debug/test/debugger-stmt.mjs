// `debugger;` must stop the debuggee even with zero breakpoints set: the
// engine treats the opcode itself as a breakpoint (reason "breakpoint").
// Written because the docs used to claim `debugger;` was a no-op — this test
// pins the real behaviour.
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

const SRC = '/tmp/dap_debugger_stmt.js';

const cfg = {
  type: 'qzjs',
  request: 'launch',
  name: 'debugger-stmt',
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

writeFileSync(
  SRC,
  [
    'console.log("before");',
    'debugger;',
    'console.log("after");',
    '',
  ].join('\n'),
);

let failed = 0;
const fail = (msg) => { failed++; console.log('FAIL: ' + msg); };

await send('initialize', { adapterID: 'qzjs', clientID: 'smoke', pathFormat: 'path' });
// No breakpoints at all: what stops must be the `debugger;` statement itself.
await send('setBreakpoints', { source: { path: SRC }, breakpoints: [] });
await send('configurationDone');

// Stop 1: entry (before any user statement runs) — the engine stays paused
// here until the client resumes, same as smoke.mjs.
const n1 = await waitStopped(1);
if (n1 < 1) fail('no entry stop');

// Resume past entry → `debugger;` on line 2 must stop us, with zero
// breakpoints registered.
await send('continue', { threadId: 1 });
const n2 = await waitStopped(2);
console.log('stops:', stoppedEvents().length, 'reasons:', stoppedEvents().map((e) => e.body?.reason).join(','));
if (n2 < 2) {
  fail('debugger; did not stop (no second stopped event)');
} else {
  const reason = stoppedEvents()[1].body?.reason;
  console.log('debugger-stmt stop reason:', reason);
  if (reason !== 'breakpoint') fail(`reason ${reason} !== breakpoint`);

  // Frame must point at the real file/line so the editor can highlight it.
  const st = await send('stackTrace', { threadId: 1, startFrame: 0, levels: 20 });
  const top = st.body?.stackFrames?.[0];
  console.log('debugger-stmt frame:', top?.source?.path, top?.line);
  if (!top) fail('no stack frames');
  else {
    if (top.source.path !== SRC) fail(`frame path ${top.source.path} !== ${SRC}`);
    if (top.line !== 2) fail(`frame line ${top.line} !== 2`);
  }
}

// Resume again → run to completion.
await send('continue', { threadId: 1 });
const t0 = Date.now();
while (!events.some((e) => e.event === 'terminated') && Date.now() - t0 < 6000) {
  await new Promise((r) => setTimeout(r, 50));
}
if (!events.some((e) => e.event === 'terminated')) fail('no terminated event after final continue');
console.log('events:', events.map((e) => e.event).join(','));
console.log(failed === 0 ? 'DEBUGGER-STMT PASS' : 'DEBUGGER-STMT FAIL');
process.exit(failed === 0 ? 0 : 1);
