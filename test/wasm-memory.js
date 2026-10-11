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

suite('Wasm source reservation', () => {
  const reference = new WebAssembly.Instance(new WebAssembly.Module(binary)).exports;
  const bytes = reference.memory.buffer.byteLength;
  const heap = reference.__heap_base.value;
  const cases = [];
  for (const remaining of [12, 10, 0, -2]) {
    cases.push({ remaining, tail: ';', expected: { exports: [], reexports: [] } });
    cases.push({ remaining, tail: 'module.exports={π}', expected: { exports: ['π'], reexports: [] } });
  }
  for (const tail of ['_', 'module', 'Object', '_interopRequireWildcard']) {
    cases.push({ remaining: 0, tail, expected: { exports: [], reexports: [] } });
  }

  for (const mode of ['automatic', 'async', 'sync']) {
    for (const copyLoop of [false, true]) {
      test(`${mode} initialization with ${copyLoop ? 'UTF-16 loop' : 'Buffer'} copying`, async () => {
        const originalInstance = WebAssembly.Instance;
        const originalInstantiate = WebAssembly.instantiate;
        const originalBuffer = globalThis.Buffer;
        let instance;
        WebAssembly.Instance = new Proxy(originalInstance, {
          /**
           * @param {typeof WebAssembly.Instance} target
           * @param {ConstructorParameters<typeof WebAssembly.Instance>} args
           */
          construct(target, args) {
            instance = Reflect.construct(target, args);
            return instance;
          }
        });
        WebAssembly.instantiate = new Proxy(originalInstantiate, {
          /**
           * @param {typeof WebAssembly.instantiate} target
           * @param {typeof WebAssembly} receiver
           * @param {Parameters<typeof WebAssembly.instantiate>} args
           */
          async apply(target, receiver, args) {
            const result = await Reflect.apply(target, receiver, args);
            instance = result.instance ?? result;
            return result;
          }
        });
        try {
          let count = 0;
          for (const { remaining, tail, expected } of cases) {
            if (copyLoop) globalThis.Buffer = undefined;
            const lexer = await import(`../dist/lexer.mjs?source-${mode}-${copyLoop}-${count++}`);
            globalThis.Buffer = originalBuffer;
            if (mode === 'async') await lexer.init();
            if (mode === 'sync') lexer.initSync();
            const length = (bytes - heap - remaining) / 2 - 2;
            const source = ' '.repeat(length - tail.length) + tail;
            const result = lexer.parse(source);
            assert.deepStrictEqual(result, expected);
            const grows = remaining < 0 || (expected.exports.length > 0 && remaining < 12);
            assert.equal(instance.exports.memory.buffer.byteLength, bytes + (grows ? 65536 : 0));
            assert.deepStrictEqual(lexer.parse('exports.next=1;'), { exports: ['next'], reexports: [] });
            assert.deepStrictEqual(result, expected);
          }
        } finally {
          WebAssembly.Instance = originalInstance;
          WebAssembly.instantiate = originalInstantiate;
          globalThis.Buffer = originalBuffer;
        }
      });
    }
  }
});
