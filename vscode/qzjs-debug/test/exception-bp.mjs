// Exception breakpoints (DAP filter "all"): with the filter armed, a `throw`
// — even one that is caught — stops with reason=exception carrying the error
// message, at the throw site's frame/line, and exactly ONCE per throw (the
// engine suppresses restorations of an already-thrown exception). With the
// filter disarmed (filters:[] — what VS Code sends when nothing is checked),
// the same throw runs through without stopping.
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

const SRC = '/tmp/dap_exception.js';

const cfg = () => ({
  type: 'qzjs',
  request: 'launch',
  name: 'exception-bp',
  program: SRC,
  runtimeExecutable:
    process.env.QZJS_RUNTIME ||
    fileURLToPath(new URL('../../../build_dbg/qzjs', import.meta.url)),
  runtimeArgs: [],
  env: {},
});

const src = [
  'function boom() {', // 1
  '  throw new Error("boom");', // 2  ← throw site
  '}', // 3
  'try {', // 4
  '  boom();', // 5
  '} catch (e) {', // 6
  '  console.log("caught", e.message);', // 7
  '}', // 8
  'console.log("end");', // 9
  '',
].join('\n');
writeFileSync(SRC, src);

let failed = 0;
const fail = (msg) => { failed++; console.log('FAIL: ' + msg); };

/** Run one full session; returns its event list. */
async function runSession({ armException }) {
  const { toAdapter, toClient } = connect(new QzjsDebugSession(cfg()));
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
  const send = (cmd, args = {}) =>
    new Promise((resolve, reject) => {
      const s = ++seq;
      pending.set(s, resolve);
      setTimeout(() => reject(new Error('timeout ' + cmd)), 10000);
      toAdapter.emit('msg', { type: 'request', seq: s, command: cmd, arguments: args });
    });
  const stopped = () => events.filter((e) => e.event === 'stopped');
  const waitStopped = async (n, ms = 6000) => {
    const t0 = Date.now();
    while (stopped().length < n && Date.now() - t0 < ms) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return stopped().length;
  };

  const init = await send('initialize', {
    adapterID: 'qzjs', clientID: 'exception', pathFormat: 'path',
  });
  const filters = init.body?.exceptionBreakpointFilters ?? [];
  if (!filters.some((f) => f.filter === 'all')) {
    fail(`capability missing: exceptionBreakpointFilters = ${JSON.stringify(filters)}`);
  }

  const seb = await send('setExceptionBreakpoints', {
    filters: armException ? ['all'] : [],
  });
  console.log('setExceptionBreakpoints raw:', JSON.stringify(seb));
  if (armException) {
    const b = seb.body?.breakpoints?.[0];
    if (b?.verified !== true) fail(`armed filter not verified: ${JSON.stringify(seb.body)}`);
  }

  await send('configurationDone');
  const n1 = await waitStopped(1);
  if (n1 < 1) fail('no entry stop');
  await send('continue', { threadId: 1 });
  return { events, stopped, waitStopped, send };
}

// ---------- Session A: filter armed ----------
{
  const s = await runSession({ armException: true });

  const n = await s.waitStopped(2, 8000);
  if (n < 2) {
    fail(`exception stop never happened (stops=${s.stopped().length}: ` +
      s.stopped().map((e) => e.body?.reason).join(',') + ')');
  } else {
    const exc = s.stopped()[1];
    const body = exc.body ?? {};
    console.log('exception stop:', JSON.stringify(body));
    if (body.reason !== 'exception') fail(`stop 2 reason = ${body.reason}, expected "exception"`);
    if (!String(body.text ?? '').includes('boom')) {
      fail(`stop text lacks the error message: ${JSON.stringify(body.text)}`);
    }
    const st = await s.send('stackTrace', { threadId: 1, startFrame: 0, levels: 3 });
    const top = st.body?.stackFrames?.[0];
    console.log('throw site:', top?.source?.path, top?.line, top?.name);
    if (top?.source?.path !== SRC) fail(`throw-site path ${top?.source?.path} !== ${SRC}`);
    if (top?.line !== 2) fail(`throw-site line ${top?.line} !== 2`);
  }

  // exactly one stop per throw — no double-fire from restorations
  await s.send('continue', { threadId: 1 });
  const t0 = Date.now();
  while (!s.events.some((e) => e.event === 'terminated') && Date.now() - t0 < 6000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const total = s.stopped().length;
  if (total !== 2) {
    fail(`expected exactly 2 stops (entry + one exception), got ${total}: ` +
      s.stopped().map((e) => e.body?.reason).join(','));
  }
  if (!s.events.some((e) => e.event === 'terminated')) fail('session A never terminated');
  console.log('A events:', s.events.map((e) => e.event).join(','));
}

// ---------- Session B: filter disarmed ----------
{
  const s = await runSession({ armException: false });
  // give the catch/throw plenty of time to (not) stop
  await new Promise((r) => setTimeout(r, 800));
  const n = s.stopped().length;
  if (n !== 1) {
    fail(`disarmed filter still stopped (${n} stops): ` +
      s.stopped().map((e) => e.body?.reason).join(','));
  }
  if (!s.events.some((e) => e.event === 'terminated')) {
    // it may still be running; nudge and wait
    if (n >= 1) await s.send('continue', { threadId: 1 });
    const t0 = Date.now();
    while (!s.events.some((e) => e.event === 'terminated') && Date.now() - t0 < 6000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!s.events.some((e) => e.event === 'terminated')) fail('session B never terminated');
  }
  const out = s.events.filter((e) => e.event === 'output').map((e) => e.body?.output ?? '').join('');
  if (!out.includes('caught boom')) fail(`session B output wrong: ${JSON.stringify(out)}`);
  console.log('B events:', s.events.map((e) => e.event).join(','));
}

console.log(failed === 0 ? 'EXCEPTION-BP PASS' : 'EXCEPTION-BP FAIL');
process.exit(failed === 0 ? 0 : 1);
