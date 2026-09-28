// End-to-end: DAP hitCondition (hit-count breakpoints) through the adapter.
//
// The line-3 statement executes once per loop iteration (6 reaches). With
// hitCondition "%2" the breakpoint must stop on reaches 2, 4 and 6 — exactly
// three stops, none inflating after a continue (the same-statement re-hit
// guard must not count the re-dispatch). A second breakpoint carries an
// invalid hitCondition: C rejects registration (verified:false + message)
// and applyVerified must NOT re-enable it just because the line exists in
// the file. Program stdout (`s 15`) asserts the loop ran to completion.
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

const SRC = '/tmp/dap_hit.js';

const cfg = {
  type: 'qzjs',
  request: 'launch',
  name: 'hit-condition',
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
  'let s = 0;',
  'for (let i = 0; i < 6; i++) {',
  '  s += i;',
  '}',
  "console.log('s', s);",
  '',
].join('\n');
writeFileSync(SRC, src);

let failed = 0;
const fail = (msg) => { failed++; console.log('FAIL: ' + msg); };

const initResp = await send('initialize', { adapterID: 'qzjs', clientID: 'hit', pathFormat: 'path' });
if (initResp.body?.supportsHitConditionalBreakpoints !== true) {
  fail('supportsHitConditionalBreakpoints not advertised');
}
const bpResp = await send('setBreakpoints', {
  source: { path: SRC },
  breakpoints: [
    { line: 3, hitCondition: '%2' },
    { line: 5, hitCondition: 'also-bad' },
  ],
});
const bps = bpResp.body?.breakpoints ?? [];
console.log('bps:', JSON.stringify(bps));
if (bps[0]?.verified !== true) fail('%2 breakpoint not verified');
if (bps[1]?.verified !== false) fail('invalid hitCondition not verified:false');
if (bps[1] && !String(bps[1].message ?? '').includes('hitCondition')) {
  fail('missing invalid-hitCondition message: ' + JSON.stringify(bps[1]));
}

await send('configurationDone');

// entry stop → three "%2" stops → completion
if ((await waitStopped(1)) < 1) fail('no entry stop');
for (let k = 2; k <= 4; k++) {
  await send('continue', { threadId: 1 });
  if ((await waitStopped(k)) < k) fail('missing hit stop #' + k);
}
// exactly 4 stops total (entry + three %2 hits) — the count must not drift
if (stoppedEvents().length !== 4) {
  fail('unexpected stop count: ' + stoppedEvents().length);
}
// one of the hit stops must be at line 3
const st = await send('stackTrace', { threadId: 1, startFrame: 0, levels: 20 });
const topLine = st.body?.stackFrames?.[0]?.line;
console.log('last hit stop at line:', topLine);
if (topLine !== 3) fail('last hit stop not at line 3 (line=' + topLine + ')');

// run to completion: the loop must have run all 6 iterations (s = 15)
await send('continue', { threadId: 1 });
const t0 = Date.now();
while (!events.some((e) => e.event === 'terminated') && Date.now() - t0 < 6000) {
  await new Promise((r) => setTimeout(r, 50));
}
const outputs = events
  .filter((e) => e.event === 'output')
  .map((e) => e.body?.output ?? '')
  .join('');
console.log('outputs:', JSON.stringify(outputs));
if (!outputs.includes('s 15')) fail('program stdout missing/wrong: ' + outputs);

console.log(failed === 0 ? 'HIT-COND PASS' : 'HIT-COND FAIL');
process.exit(failed === 0 ? 0 : 1);
