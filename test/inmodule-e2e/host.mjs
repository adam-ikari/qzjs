// in-module guest harness (§10.4 「import 拉」宿主 shim)
//
// 实例化 libqzvm.wasm（qzvm-guest 产物），提供 qz_host.* 宿主能力：
//   fs_read(path_ptr, path_len) -> op_id   异步文件读，完成后入队
//   drain(buf_ptr, max)         -> n        拉一批完成事件（[op_id][status][len][data]）
// 并驱动 guest 导出 qz_create/qz_eval/qz_tick/qz_destroy/qz_result_*。
//
// 证明：guest 持 resolve(JSValue)，宿主无 JSContext，经队列拉回复流。
// 用法：node host.mjs --wasm <libqzvm.wasm> --data <dir-with-fixtures>
import { readFileSync, readFile as readFileAsync } from 'node:fs';
import { WASI } from 'node:wasi';
import path from 'node:path';

function fail(msg) { console.error('FAIL: ' + msg); process.exit(1); }

const args = process.argv.slice(2);
function opt(name) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : undefined;
}
const wasmPath = opt('wasm');
const dataDir = opt('data');
if (!wasmPath || !dataDir) fail('usage: node host.mjs --wasm <libqzvm.wasm> --data <dir>');

const wasi = new WASI({ version: 'preview1', args: [], env: {} });
const mod = new WebAssembly.Module(readFileSync(wasmPath));

const queue = [];   // {op_id, status, data:Buffer}
let nextOp = 1;
let mem = null;

const guestStr = (ptr, len) =>
  Buffer.from(new Uint8Array(mem.buffer, ptr, len)).toString('utf8');
const guestWrite = (ptr, buf) =>
  new Uint8Array(mem.buffer, ptr, buf.length).set(buf);

const imports = {
  qz_host: {
    fs_read: (pathPtr, pathLen) => {
      const file = guestStr(pathPtr, pathLen);
      const op = nextOp++;
      readFileAsync(file, (err, data) => {
        if (err) queue.push({ op_id: op, status: err.errno ?? 1,
                              data: Buffer.from(String(err.code ?? err.message)) });
        else     queue.push({ op_id: op, status: 0, data: Buffer.from(data) });
      });
      return op;
    },
    drain: (bufPtr, max) => {
      if (!queue.length || max < 12) return 0;
      const e = queue.shift();
      const body = e.data.subarray(0, Math.max(0, max - 12));
      const hdr = Buffer.alloc(12);
      hdr.writeInt32LE(e.op_id, 0);
      hdr.writeInt32LE(e.status, 4);
      hdr.writeInt32LE(e.data.length, 8);
      guestWrite(bufPtr, hdr);
      guestWrite(bufPtr + 12, body);
      return 12 + body.length;
    },
  },
  wasi_snapshot_preview1: wasi.wasiImport,
};

const inst = new WebAssembly.Instance(mod, imports);
wasi.initialize?.(inst);
const ex = inst.exports;
mem = ex.memory;

// 在 guest 上 eval 一段脚本（拷贝到 guest 内存 + NUL 终止）。
function evalGuest(rt, script) {
  const b = Buffer.from(script, 'utf8');
  const p = ex.malloc(b.length + 1);
  if (!p) fail('guest malloc failed');
  guestWrite(p, b);
  new Uint8Array(mem.buffer)[p + b.length] = 0;
  return ex.qz_eval(rt, p, b.length);
}

// 驱动 tick 直到 guest 结果槽被填（或超时）。返回结果字符串。
async function pumpUntilResult(rt, limit = 400) {
  for (let i = 0; i < limit && ex.qz_result_len() === 0; i++) {
    await new Promise((r) => setTimeout(r, 1));   // 让宿主异步回调落地
    ex.qz_tick(rt);
  }
  const rl = ex.qz_result_len();
  return rl ? guestStr(ex.qz_result_ptr(), rl) : null;
}

let failures = 0;
function check(name, got, want) {
  if (got === want) { console.log(`ok   ${name}`); return; }
  console.log(`FAIL ${name}: want ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
  failures++;
}

const dataFile = path.join(dataDir, 'data.txt');
const missing = path.join(dataDir, 'NOPE.txt');

// ── 1: 成功路径（异步读 → 回流 → then）──
{
  const rt = ex.qz_create(0, 0);
  if (!rt) fail('qz_create returned 0');
  evalGuest(rt, `
    fsRead(${JSON.stringify(dataFile)}).then(txt => {
      __qz_set_result('OK len=' + txt.length + ' head=' + txt.split('\\n')[0]);
    }, e => __qz_set_result('ERR ' + e));
  `);
  check('read success', await pumpUntilResult(rt), 'OK len=33 head=hello from host file');
  ex.qz_destroy(rt);
}

// ── 2: 拒绝路径（ENOENT → reject）──
{
  const rt = ex.qz_create(0, 0);
  evalGuest(rt, `
    fsRead(${JSON.stringify(missing)}).then(
      () => __qz_set_result('UNEXPECTED resolve'),
      e => __qz_set_result('ERR ' + e));
  `);
  check('read reject', await pumpUntilResult(rt), 'ERR ENOENT');
  ex.qz_destroy(rt);
}

// ── 3: 两个并发 op（op 表按 op_id 派发，顺序无关）──
{
  const rt = ex.qz_create(0, 0);
  evalGuest(rt, `
    var done = [];
    function fin() {
      if (done.length === 2) __qz_set_result('OK ' + done.sort().join(','));
    }
    fsRead(${JSON.stringify(dataFile)}).then(t => { done.push('a' + t.length); fin(); });
    fsRead(${JSON.stringify(missing)}).then(() => {}, e => { done.push('b' + e); fin(); });
  `);
  check('two concurrent ops', await pumpUntilResult(rt), 'OK a33,bENOENT');
  ex.qz_destroy(rt);
}

if (failures) fail(`${failures} check(s) failed`);
console.log('PASS: in-module guest async reflow');
