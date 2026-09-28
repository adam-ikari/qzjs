// Logpoints: a breakpoint carrying `logMessage` must never stop — the engine
// stops (it knows nothing of logpoints), the adapter intercepts the stop,
// interpolates {expression} holes via evaluate in the paused frame, emits the
// result as Debug Console output and continues. Mixed with one real
// breakpoint in the same session to prove the normal stop path still works.
//
// Interpolation runs through the same evaluate path as watch, so `locals.*`
// refers to the paused frame's locals.
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

const SRC = '/tmp/dap_logpoints.js';
const LOG_LINE = 4; // acc.push(i) — a logpoint
const BP_LINE = 6; // console.log(...) — a real breakpoint

const cfg = {
  type: 'qzjs',
  request: 'launch',
  name: 'logpoints',
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
const outputText = () =>
  events.filter((e) => e.event === 'output').map((e) => e.body?.output ?? '').join('');
async function waitOutputIncludes(needle, ms = 6000) {
  const t0 = Date.now();
  while (!outputText().includes(needle) && Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return outputText().includes(needle);
}

const src = [
  'function main() {', // 1
  '  let acc = [];', // 2
  '  for (let i = 1; i <= 3; i++) {', // 3
  '    acc.push(i);', // 4  ← logpoint
  '  }', // 5
  '  console.log("done", acc.join(","));', // 6  ← breakpoint
  '}', // 7
  'main();', // 8
  '',
].join('\n');
writeFileSync(SRC, src);

let failed = 0;
const fail = (msg) => { failed++; console.log('FAIL: ' + msg); };

await send('initialize', { adapterID: 'qzjs', clientID: 'logpoints', pathFormat: 'path' });
const bpResp = await send('setBreakpoints', {
  source: { path: SRC },
  breakpoints: [
    { line: LOG_LINE, logMessage: 'hit i={locals.i} len={locals.acc.length}' },
    { line: BP_LINE },
  ],
});
const reported = bpResp.body?.breakpoints ?? [];
console.log('setBreakpoints:', JSON.stringify(reported));
if (reported.length !== 2 || reported.some((b) => b.verified !== true)) {
  fail('setBreakpoints did not verify both breakpoints: ' + JSON.stringify(reported));
}
await send('configurationDone');

// entry stop, as in smoke
const n1 = await waitStopped(1);
if (n1 < 1) fail('no entry stop');

// run: the loop must produce three log outputs WITHOUT stopping on line 4
await send('continue', { threadId: 1 });

for (const want of ['hit i=1 len=0', 'hit i=2 len=1', 'hit i=3 len=2']) {
  if (!(await waitOutputIncludes(want))) {
    fail(`logpoint output missing: "${want}" (got: ${JSON.stringify(outputText())})`);
  }
}

// the only later stop is the real breakpoint on line 6
const n2 = await waitStopped(2);
if (n2 !== 2) {
  fail(
    `expected exactly 2 stops (entry + line ${BP_LINE}), got ${n2}: ` +
      stoppedEvents().map((e) => `@${e.body?.line ?? '?'}`).join(','),
  );
} else {
  const st = await send('stackTrace', { threadId: 1, startFrame: 0, levels: 1 });
  const top = st.body?.stackFrames?.[0];
  console.log('stop at:', top?.source?.path, top?.line);
  if (top?.line !== BP_LINE) fail(`stopped on line ${top?.line}, expected ${BP_LINE}`);
}

// no extra stop may be hiding behind a delay: run to completion
await send('continue', { threadId: 1 });
const t0 = Date.now();
while (!events.some((e) => e.event === 'terminated') && Date.now() - t0 < 6000) {
  await new Promise((r) => setTimeout(r, 50));
}
if (!events.some((e) => e.event === 'terminated')) fail('never terminated');
if (stoppedEvents().length !== 2) {
  fail(`final stop count ${stoppedEvents().length} !== 2 (logpoint stopped the world)`);
}
if (!outputText().includes('done')) fail('program output missing — did it run to completion?');

console.log('events:', events.map((e) => e.event).join(','));
console.log(failed === 0 ? 'LOGPOINTS PASS' : 'LOGPOINTS FAIL');
process.exit(failed === 0 ? 0 : 1);
