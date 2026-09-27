// End-to-end smoke: instantiate the inline DebugSession, drive it as if we
// were VS Code, with the real build_dbg/qzjs as the debuggee.
//
// Verifies the whole relay: spawn + QZ_DEBUG=1 + DAP frame forwarding, and —
// the part that used to be broken — a breakpoint set on the *real* source
// path. The CLI ships user code through the {"cmd":"eval"} channel, so unless
// the engine is told which file that string came from it records "<input>",
// bp_find's exact strcmp misses, and the second stop never happens.
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { QzjsDebugSession } from '../out/adapter/qzjsDebugSession.js';

function connect(session) {
  // VS Code <-> adapter duplex: two event emitters bridged.
  // ProtocolServer exposes onDidSendMessage (adapter → VS Code) and
  // handleMessage (VS Code → adapter).
  const toAdapter = new EventEmitter();
  const toClient = new EventEmitter();
  session.onDidSendMessage((msg) => toClient.emit('msg', msg));
  toAdapter.on('msg', (msg) => session.handleMessage(msg));
  return { toAdapter, toClient };
}

const SRC = '/tmp/dap_app.js';
const BP_LINE = 3; // `return y;` — deliberately not the entry line

const cfg = {
  type: 'qzjs',
  request: 'launch',
  name: 'smoke',
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

const src = [
  'function f(x) {',
  '  let y = x * 2;',
  '  return y;',
  '}',
  'const r = f(21);',
  'console.log("result", r);',
  '',
].join('\n');
writeFileSync(SRC, src);

let failed = 0;
const fail = (msg) => { failed++; console.log('FAIL: ' + msg); };

await send('initialize', { adapterID: 'qzjs', clientID: 'smoke', pathFormat: 'path' });
const bpResp = await send('setBreakpoints', {
  source: { path: SRC },
  breakpoints: [{ line: BP_LINE }],
});
const bpReported = bpResp.body?.breakpoints?.[0];
console.log('setBreakpoints verified:', bpReported?.verified, 'line:', bpReported?.line);
if (bpReported?.verified !== true) fail('setBreakpoints did not report verified');
await send('configurationDone');

// 1) pause at entry (happens while the bootstrap is still running)
const n1 = await waitStopped(1);
if (n1 < 1) fail('no entry stop');
console.log('stopped after configuration:', n1);

// 2) continue → the breakpoint on the real path must hit
await send('continue', { threadId: 1 });
const n2 = await waitStopped(2);
console.log('stopped after continue:', n2);
if (n2 < 2) {
  fail(
    `breakpoint on the real path never hit (stops=${n2}, reasons=${stoppedEvents()
      .map((e) => e.body?.reason)
      .join(',')})`,
  );
} else {
  const bpStop = stoppedEvents()[1];
  const reason = bpStop.body?.reason;
  console.log('second stop reason:', reason);
  if (reason !== 'breakpoint') fail(`second stop reason is ${reason}, not breakpoint`);

  // 3) the frame must name the real file (VS Code matches it to the editor)
  const st = await send('stackTrace', { threadId: 1, startFrame: 0, levels: 20 });
  const top = st.body?.stackFrames?.[0];
  console.log('top frame:', top?.source?.path, top?.line, top?.name);
  if (!top) fail('no stack frames');
  else {
    if (top.source.path !== SRC) fail(`frame path ${top.source.path} !== ${SRC}`);
    if (top.line !== BP_LINE) fail(`frame line ${top.line} !== ${BP_LINE}`);
  }
}

// 4) run to completion → terminated
await send('continue', { threadId: 1 });
const t0 = Date.now();
while (!events.some((e) => e.event === 'terminated') && Date.now() - t0 < 6000) {
  await new Promise((r) => setTimeout(r, 50));
}
console.log('events:', events.map((e) => e.event).join(','));
console.log(failed === 0 ? 'SMOKE PASS' : 'SMOKE FAIL');
process.exit(failed === 0 ? 0 : 1);
