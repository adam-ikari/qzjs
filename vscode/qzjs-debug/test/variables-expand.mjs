// End-to-end: DAP variablesReference hierarchy through the real adapter.
//
// A nested object + array local must be drillable from the Locals scope
// (o → nested → b → elements), evaluate results must be expandable, and the
// next stop must invalidate the previous stop's references (generation
// bump). Also asserts program stdout still reaches the Debug Console after
// the relay-parser rewrite (the `r 7` line printed once the function returns).
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

const SRC = '/tmp/dap_vars.js';
// Breakpoints AFTER every asserted local is initialized — a breakpoint stops
// at its statement's entry, where a `const` local is still in its TDZ. Two
// stops in one frame also drive the stale-reference check below.
const BP_LINES = [4, 5];

const cfg = {
  type: 'qzjs',
  request: 'launch',
  name: 'variables-expand',
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
  'function f() {',
  '  const o = { a: 1, nested: { b: [7, 8] } };',
  '  const arr = [4, 5];',
  '  const sum = o.a + arr[0];',
  '  return sum;',
  '}',
  'const r = f();',
  'console.log("r", r);',
  '',
].join('\n');
writeFileSync(SRC, src);

let failed = 0;
const fail = (msg) => { failed++; console.log('FAIL: ' + msg); };
const findVar = (resp, name) =>
  (resp.body?.variables ?? []).find((v) => v.name === name);

await send('initialize', { adapterID: 'qzjs', clientID: 'vars', pathFormat: 'path' });
const bpResp = await send('setBreakpoints', {
  source: { path: SRC },
  breakpoints: BP_LINES.map((line) => ({ line })),
});
if (bpResp.body?.breakpoints?.some((b) => b.verified !== true)) {
  fail('setBreakpoints not verified: ' + JSON.stringify(bpResp.body));
}
await send('configurationDone');

// entry stop → continue → first breakpoint stop (line 4)
if ((await waitStopped(1)) < 1) fail('no entry stop');
await send('continue', { threadId: 1 });
if ((await waitStopped(2)) < 2) fail('no breakpoint stop');

// stackTrace → scopes → Locals reference
const st = await send('stackTrace', { threadId: 1, startFrame: 0, levels: 20 });
const frameId = st.body?.stackFrames?.[0]?.id;
if (frameId === undefined) fail('no stack frame');
const sc = await send('scopes', { frameId });
const localsRef = sc.body?.scopes?.[0]?.variablesReference;
if (!localsRef) fail('no Locals variablesReference');

// 1) top level: object + array both expandable, previews intact
const top = await send('variables', { variablesReference: localsRef });
const oVar = findVar(top, 'o');
const arrVar = findVar(top, 'arr');
console.log('top:', (top.body?.variables ?? []).map((v) => `${v.name}=${v.value}[${v.type} ref=${v.variablesReference}]`).join(' '));
if (!oVar || oVar.variablesReference <= 0) fail('o not expandable: ' + JSON.stringify(oVar));
if (!arrVar || arrVar.variablesReference <= 0) fail('arr not expandable: ' + JSON.stringify(arrVar));
if (oVar && !String(oVar.value).includes('nested')) fail('o preview lacks nested: ' + oVar.value);
if (arrVar && arrVar.type !== 'array') fail('arr type is ' + arrVar?.type);

// 2) drill o → nested → b → elements
if (oVar?.variablesReference > 0) {
  const kids = await send('variables', { variablesReference: oVar.variablesReference });
  const aVar = findVar(kids, 'a');
  const nested = findVar(kids, 'nested');
  console.log('o kids:', (kids.body?.variables ?? []).map((v) => `${v.name}=${v.value}`).join(' '));
  if (!aVar || aVar.value !== '1') fail('o.a wrong: ' + JSON.stringify(aVar));
  if (!nested || nested.variablesReference <= 0) fail('nested not expandable');
  if (nested?.variablesReference > 0) {
    const nk = await send('variables', { variablesReference: nested.variablesReference });
    const bVar = findVar(nk, 'b');
    if (!bVar || bVar.variablesReference <= 0) fail('nested.b not expandable');
    if (bVar?.variablesReference > 0) {
      const elems = await send('variables', { variablesReference: bVar.variablesReference });
      const e0 = findVar(elems, '0');
      const e1 = findVar(elems, '1');
      console.log('b elems:', (elems.body?.variables ?? []).map((v) => `${v.name}=${v.value}`).join(' '));
      if (!e0 || e0.value !== '7') fail('b[0] wrong: ' + JSON.stringify(e0));
      if (!e1 || e1.value !== '8') fail('b[1] wrong: ' + JSON.stringify(e1));
      if (e0 && e0.variablesReference !== 0) fail('leaf must have ref 0');
    }
  }
}

// 3) evaluate result is expandable too (hover / watch drill-in)
const ev = await send('evaluate', { expression: 'locals.o', frameId });
console.log('evaluate:', ev.body?.result, 'ref=', ev.body?.variablesReference);
if (ev.body?.variablesReference > 0) {
  const ek = await send('variables', { variablesReference: ev.body.variablesReference });
  if (!findVar(ek, 'a')) fail('evaluate ref children wrong');
} else {
  fail('evaluate result not expandable');
}

// 4) next stop (line 5) must invalidate the first stop's reference
await send('continue', { threadId: 1 });
if ((await waitStopped(3)) < 3) fail('no second breakpoint stop');
if (oVar?.variablesReference > 0) {
  const stale = await send('variables', { variablesReference: oVar.variablesReference });
  const n = stale.body?.variables?.length;
  console.log('stale ref children:', n);
  if (n !== 0) fail('stale reference not invalidated (children=' + n + ')');
}

// 5) run to completion: program stdout must reach the Debug Console
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
if (!outputs.includes('r 5')) fail('program stdout missing from Debug Console');

console.log(failed === 0 ? 'VARS-EXPAND PASS' : 'VARS-EXPAND FAIL');
process.exit(failed === 0 ? 0 : 1);
