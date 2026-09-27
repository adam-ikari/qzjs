// Every kind of statement line must be a fireable breakpoint: `return 1;`
// (constant, no expression marker), `do {`, `case`/`default:`, `break;`,
// `try`/`catch`/`finally` headers, `switch`, `while` condition — not just
// expression statements. The pc2line table used to have no entry for those
// lines at all, so a breakpoint set on them silently never fired.
//
// The program is written so that some breakpoint lines never execute
// (line 3: `return 1;` with a=3; lines 11/12: `default:` when `case 0:`
// matches) — those must NOT stop. The exact stop sequence is asserted.
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

const SRC = '/tmp/dap_line_coverage.js';

const cfg = {
  type: 'qzjs',
  request: 'launch',
  name: 'line-coverage',
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
    'function f(a) {',            // 1
    '  if (a > 10) {',            // 2
    '    return 1;',              // 3   never executes (a=3)
    '  }',                        // 4
    '  do {',                     // 5
    '    a--;',                   // 6   three iterations: a = 2, 1, 0
    '  } while (a > 0);',         // 7   condition checked three times
    '  switch (a) {',             // 8
    '  case 0:',                  // 9
    '    break;',                 // 10
    '  default:',                 // 11  never dispatched (case 0 matches)
    '    a = 7;',                 // 12  never executes
    '  }',                        // 13
    '  try {',                    // 14
    '    throw new Error("x");',  // 15
    '  } catch (e) {',            // 16
    '    a = 3;',                 // 17
    '  } finally {',              // 18
    '    a = 4;',                 // 19
    '  }',                        // 20
    '  return a;',                // 21
    '}',                          // 22
    'f(3);',                      // 23
    '',
  ].join('\n'),
);

// Breakpoints on every statement line (closing braces 4/13/20/22 are not
// breakable — they generate no code of their own). Lines 3, 11, 12 never
// execute; the exact sequence below asserts both the hits and the non-hits.
const BP_LINES = [2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 21];
// The exact stop sequence, hit and non-hit alike. Two quirks are pinned on
// purpose: line 5 re-fires once per do-while iteration (the back-jump
// re-enters the `do {` region — correct line-entry semantics), and line 17
// re-fires once after the finally block (the try/finally continuation is
// inline code physically inside the catch body's line region, so returning
// from finally re-enters line 17 — a structural property of the engine's
// gosub-based finally, not of any single marker).
const EXPECTED_STOPS = [
  2, 5, 6, 7, 5, 6, 7, 5, 6, 7, 8, 9, 10, 14, 15, 16, 17, 18, 19, 17, 21,
];

let failed = 0;
const fail = (msg) => { failed++; console.log('FAIL: ' + msg); };

await send('initialize', { adapterID: 'qzjs', clientID: 'smoke', pathFormat: 'path' });
const bpResp = await send('setBreakpoints', {
  source: { path: SRC },
  breakpoints: BP_LINES.map((line) => ({ line })),
});
const reported = bpResp.body?.breakpoints ?? [];
console.log('setBreakpoints:', reported.length, 'verified:', reported.filter((b) => b.verified).length);
if (reported.length !== BP_LINES.length) fail(`reported ${reported.length} breakpoints !== ${BP_LINES.length}`);
if (reported.some((b) => b.verified !== true)) fail('some breakpoints not verified');
await send('configurationDone');

// Stop 1: entry pause (same harness behaviour as smoke/debugger-stmt).
if ((await waitStopped(1)) < 1) fail('no entry stop');
await send('continue', { threadId: 1 });

const base = stoppedEvents().length;
const seen = [];
const t0 = Date.now();
while (
  !events.some((e) => e.event === 'terminated') &&
  seen.length < 40 &&
  Date.now() - t0 < 15000
) {
  if (stoppedEvents().length > base + seen.length) {
    const st = await send('stackTrace', { threadId: 1, startFrame: 0, levels: 5 });
    const top = st.body?.stackFrames?.[0];
    if (!top) fail('no stack frames at stop ' + (seen.length + 1));
    else seen.push(top.line);
    await send('continue', { threadId: 1 });
  } else {
    await new Promise((r) => setTimeout(r, 50));
  }
}

console.log('stops:', seen.join(','));
if (!events.some((e) => e.event === 'terminated')) fail('did not terminate');
if (JSON.stringify(seen) !== JSON.stringify(EXPECTED_STOPS)) {
  fail(`stop sequence mismatch\n  expected: ${EXPECTED_STOPS.join(',')}\n  actual:   ${seen.join(',')}`);
}
console.log(failed === 0 ? 'LINE-COVERAGE PASS' : 'LINE-COVERAGE FAIL');
process.exit(failed === 0 ? 0 : 1);
