// verified:false — the adapter reads the file the C layer can't see:
//  - a source that doesn't exist → unverified (gray dot in VS Code),
//  - a line past EOF → unverified,
//  - a valid line in an existing file → verified.
// The C layer answers "registered" (verified:true) for everything; only the
// presentation layer knows whether a breakpoint can ever fire.
import { EventEmitter } from 'node:events';
import { writeFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { QzjsDebugSession } from '../out/adapter/qzjsDebugSession.js';

function connect(session) {
  const toAdapter = new EventEmitter();
  const toClient = new EventEmitter();
  session.onDidSendMessage((msg) => toClient.emit('msg', msg));
  toAdapter.on('msg', (msg) => session.handleMessage(msg));
  return { toAdapter, toClient };
}

const SRC = '/tmp/dap_verified.js';
const MISSING = '/tmp/dap_verified_missing.js';
writeFileSync(SRC, ['const a = 1;', 'const b = 2;', 'const c = 3;', 'console.log(a, b, c);', ''].join('\n'));
if (existsSync(MISSING)) rmSync(MISSING);

const cfg = {
  type: 'qzjs',
  request: 'launch',
  name: 'verified',
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

let failed = 0;
const fail = (msg) => { failed++; console.log('FAIL: ' + msg); };
const firstBp = (resp) => resp.body?.breakpoints?.[0];

await send('initialize', { adapterID: 'qzjs', clientID: 'verified', pathFormat: 'path' });

// valid line in an existing file → verified
const okResp = await send('setBreakpoints', {
  source: { path: SRC },
  breakpoints: [{ line: 3 }],
});
console.log('valid:', JSON.stringify(firstBp(okResp)));
if (firstBp(okResp)?.verified !== true) fail('valid breakpoint not verified');

// line past EOF (file has 4 lines incl. trailing empties; 99999 is way out)
const eofResp = await send('setBreakpoints', {
  source: { path: SRC },
  breakpoints: [{ line: 99999 }],
});
console.log('past EOF:', JSON.stringify(firstBp(eofResp)));
if (firstBp(eofResp)?.verified !== false) {
  fail('line past EOF reported verified: ' + JSON.stringify(firstBp(eofResp)));
}

// a source file that doesn't exist → unverified
const missingResp = await send('setBreakpoints', {
  source: { path: MISSING },
  breakpoints: [{ line: 1 }],
});
console.log('missing:', JSON.stringify(firstBp(missingResp)));
if (firstBp(missingResp)?.verified !== false) {
  fail('missing file reported verified: ' + JSON.stringify(firstBp(missingResp)));
}

await send('configurationDone');
const t0 = Date.now();
while (!events.some((e) => e.event === 'stopped') && Date.now() - t0 < 6000) {
  await new Promise((r) => setTimeout(r, 50));
}
await send('disconnect');

console.log(failed === 0 ? 'VERIFIED PASS' : 'VERIFIED FAIL');
process.exit(failed === 0 ? 0 : 1);
