const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const binary = fs.readFileSync(path.join(__dirname, '../lib/lexer.wasm'));

suite('Wasm analysis capacity', () => {
  for (const { name, tail, read, start, end, last } of [
    { name: 'export', tail: 'exports.after=1;', read: 're', start: 'es', end: 'ee', last: 'after' },
    { name: 'reexport', tail: '__exportStar(require("target"));', read: 'rre', start: 'res', end: 'ree', last: '"target"' },
    {
      name: 'unsafe getter',
      tail: 'Object.defineProperty(exports,"v",{get:function(){return effect();}});',
      read: 'ru', start: 'us', end: 'ue', last: '"v"'
    }
  ]) {
    for (const remaining of [12, 10]) {
      test(`${name} with ${remaining} analysis bytes remaining`, () => {
        const wasm = new WebAssembly.Instance(new WebAssembly.Module(binary)).exports;
        const memory = wasm.memory.buffer;
        const bytes = memory.byteLength;
        const prefix = 'var v=0;module.exports={';
        const suffix = 'v};' + tail;
        // sa() reserves two code units beyond source.length; each shorthand adds 4 source bytes and a 12-byte Slice.
        const available = bytes - wasm.__heap_base.value - 2 * (prefix.length + suffix.length + 2) - 12;
        const count = Math.floor((available - remaining) / 16);
        const padding = (available - count * 16 - remaining) / 2;
        const source = prefix + 'v,'.repeat(count) + suffix + ' '.repeat(padding);
        const address = wasm.sa(source.length + 1);
        Buffer.from(memory, address, source.length * 2).write(source, 'utf16le');

        assert.equal(wasm.parseCJS(address, source.length, 0, 0, 0), 0);
        assert.equal(wasm.memory.buffer.byteLength, bytes + (remaining === 12 ? 0 : 65536));
        if (remaining === 12) {
          assert.equal(wasm.memory.buffer, memory);
        } else {
          assert.equal(memory.byteLength, 0);
        }
        let result;
        let records = 0;
        while (wasm[read]()) {
          result = source.slice(wasm[start](), wasm[end]());
          records++;
        }
        assert.equal(result, last);
        assert.equal(records, name === 'export' ? count + 2 : 1);
      });
    }
  }
});
