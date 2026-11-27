import test from 'node:test';
import assert from 'node:assert/strict';
import { mapOpcodes, uleb, f64c, section, vec } from './opcode-map.mjs';

const emitWasm = (code) => {
  const body = [0x01, 0x05, 0x7c, 0x02, 0x40, 0x03, 0x40, ...code, 0x0b, 0x0b, 0x20, 0x01, 0x0b];
  const typeSec = section(1, vec([[0x60, 0x01, 0x7c, 0x01, 0x7c]]));
  const funcSec = section(3, vec([[0]]));
  const name = Buffer.from('loop');
  const exportSec = section(7, vec([[name.length, ...name, 0x00, 0x00]]));
  const codeSec = section(10, vec([[...uleb(body.length), ...body]]));
  return Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...typeSec, ...funcSec, ...exportSec, ...codeSec]);
};

// Bytecode shape for `a = 5; a ??= 0; s += a` inside a numeric loop.
// Every value in this fragment is f64, so `a` cannot be nullish; taking the
// assignment body would incorrectly reset it to zero.
const numericNullishAssignment = [
  ['get_loc_check', '1', 'i', 0],
  ['get_arg0', '0', null, 1],
  ['lt', '', null, 2],
  ['if_false8', '24', null, 3],
  ['push_i32', '5', null, 4],
  ['put_loc', '2', 'a', 5],
  ['get_loc_check', '2', 'a', 6],
  ['dup', '', null, 7],
  ['is_undefined_or_null', '', null, 8],
  ['if_false8', '14', null, 9],
  ['drop', '', null, 10],
  ['push_0', '0', null, 11],
  ['dup', '', null, 12],
  ['put_loc_check', '2', 'a', 13],
  ['drop', '', null, 14],
  ['get_loc_check', '0', 's', 15],
  ['get_loc_check', '2', 'a', 16],
  ['add', '', null, 17],
  ['put_loc', '0', 's', 18],
  ['get_loc_check', '1', 'i', 19],
  ['push_1', '1', null, 20],
  ['add', '', null, 21],
  ['put_loc', '1', 'i', 22],
  ['goto8', '0', null, 23],
];

test('numeric nullish assignment skips its assignment body', async () => {
  const { code } = mapOpcodes(numericNullishAssignment);
  const { instance } = await WebAssembly.instantiate(emitWasm(code), {});
  const loop = instance.exports.loop;

  assert.equal(loop(0), 0);
  assert.equal(loop(1), 5);
  assert.equal(loop(3), 15);
});

test('forward goto is rejected instead of becoming a loop back-edge', () => {
  const ops = [
    ['push_0', '0', null, 0],
    ['goto8', '4', null, 1],
    ['push_1', '1', null, 4],
  ];
  assert.throws(() => mapOpcodes(ops), /UNMAPPED goto target: goto8 4/);
});
