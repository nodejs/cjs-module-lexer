const assert = require('node:assert/strict');

let parse;
const options = { mode: 'extended' };

suite('Extended parsing', () => {
  suiteSetup(async () => {
    if (process.env.WASM) {
      const lexer = await import('../dist/lexer.mjs');
      await lexer.init();
      parse = lexer.parse;
    } else if (process.env.WASM_SYNC) {
      const lexer = require('../dist/lexer.js');
      lexer.initSync();
      parse = lexer.parse;
    } else {
      parse = require('../lexer.js').parse;
    }
  });

  const descriptors = [
    '{ value: require("dep") }',
    '({ value: require("dep") })',
    '((/* descriptor */ { value: require("dep") }))',
    '{ enumerable: !0, get: () => value }',
    '{ configurable: true, get() { return load().default; } }',
    '{ get: function () { throw new Error("must not execute"); } }'
  ];

  for (const descriptor of descriptors) {
    test(`property descriptor ${descriptor}`, () => {
      const result = parse(`Object.defineProperty(exports, 'name', ${descriptor});`, 'fixture.cjs', options);
      assert.deepEqual(result, { exports: ['name'], reexports: [] });
    });
  }

  const values = [
    'require("dep")', 'utility.member', 'utility["member"]',
    'condition ? first() : second()', '(first(), second())',
    '`value ${`${1, 2}`}`', '/[,}]/.test(value)',
    'function () { return { nested: true }; }',
    'class { #value = 1; get value() { return this.#value; } }',
    '[1, 2, { nested: [3, 4] }]', '(() => ({ inner: 1, other: 2 }))()',
    '(numerator / denominator) / 2', '/* comma, brace } */ 1'
  ];

  for (const value of values) {
    test(`object value ${value}`, () => {
      const result = parse(`module.exports = { first: ${value}, second: 2 };`, 'fixture.cjs', options);
      assert.deepEqual(result, { exports: ['first', 'second'], reexports: [] });
    });
  }

  test('descriptors with computed constant names', () => {
    const result = parse(`Object.defineProperties(module.exports, {
      ['first']: { get() { return factory().value; } }, second: { value: 2 }
    });`, 'fixture.cjs', options);
    assert.deepEqual(result, { exports: ['first', 'second'], reexports: [] });
  });

  test('property methods and accessors', () => {
    const result = parse(`module.exports = {
      method() {}, get value() { return 1; }, set value(input) {}, ['computed']: 2
    };`, 'fixture.cjs', options);
    assert.deepEqual(result, { exports: ['method', 'value', 'computed'], reexports: [] });
  });

  test('quoted and computed accessor names and generator methods', () => {
    assert.deepEqual(parse(`module.exports = ({
      get ['first']() {}, set 'second'(value) {}, async *third() {},
      *fourth() {}, async ['fifth']() {}, get: 1, async: 2
    });`, 'fixture.cjs', options),
    { exports: ['first', 'second', 'third', 'fourth', 'fifth', 'get', 'async'], reexports: [] });
  });

  test('dynamic property expressions preserve following keys', () => {
    assert.deepEqual(parse(`module.exports = { [getName(1, 2)]: 1, after: 2 };`, 'fixture.cjs', options),
      { exports: ['after'], reexports: [] });
  });

  test('unsupported getters cannot veto other declarations', () => {
    assert.deepEqual(parse(`exports.name = 1;
      (function () { Object.defineProperty(exports, 'name', { get: () => load() }); })();`,
    'fixture.cjs', options), { exports: ['name'], reexports: [] });
  });

  test('webpack parenthesized descriptors', () => {
    assert.deepEqual(parse(`Object.defineProperty(exports, 'BaseWatchPlugin', ({
      enumerable: true, get: function () { return _BaseWatchPlugin.default; }
    }));`, 'jest-watcher.cjs', options), { exports: ['BaseWatchPlugin'], reexports: [] });
  });

  test('object spreads preserve reexports', () => {
    const result = parse(`module.exports = { first: 1, ...require('one'), second: require('value') };`,
      'fixture.cjs', options);
    assert.deepEqual(result, { exports: ['first', 'second'], reexports: ['one'] });
  });

  test('conditional reexport alternatives', () => {
    const result = parse(`if (condition) module.exports = require('one');
      else module.exports = require('two');`, 'fixture.cjs', options);
    assert.deepEqual(result, { exports: [], reexports: ['one', 'two'] });
  });

  test('names are syntactic candidates without binding analysis', () => {
    assert.deepEqual(parse('function internal(exports) { exports.internal = 1; } exports.public = 2;',
      'fixture.cjs', options), { exports: ['internal', 'public'], reexports: [] });
    assert.deepEqual(parse('const target = exports; target.name = 1;', 'fixture.cjs', options),
      { exports: [], reexports: [] });
  });

  test('parenthesized comma expressions use the final descriptor', () => {
    const result = parse(`Object.defineProperty(exports, 'name',
      ({ get() { throw new Error('unreachable'); } }, { value: 1 }));`, 'fixture.cjs', options);
    assert.deepEqual(result, { exports: ['name'], reexports: [] });
  });

  test('dynamic names and dependencies are not invented', () => {
    const result = parse(`exports[getName()] = 1;
      module.exports = require(getSpecifier());`, 'fixture.cjs', options);
    assert.deepEqual(result, { exports: [], reexports: [] });
  });

  test('source code never executes', () => {
    const result = parse(`throw new Error('source must not execute');
      exports.name = globalThis.sideEffect = 1;`, 'fixture.cjs', options);
    assert.equal(Object.hasOwn(globalThis, 'sideEffect'), false);
    assert.deepEqual(result, { exports: ['name'], reexports: [] });
  });

  test('valid CommonJS grammar and parser state', () => {
    assert.deepEqual(parse('#!/usr/bin/env node\nexports.name = 1; return;', 'fixture.cjs', options),
      { exports: ['name'], reexports: [] });
    assert.deepEqual(parse('', 'empty.cjs', options), { exports: [], reexports: [] });
  });

  test('unterminated lexical structures report the filename', () => {
    assert.throws(() => parse('module.exports = { name: 1', 'broken.cjs', options),
      /** @param {Error} error */
      error => error instanceof Error && error.message.includes('broken.cjs'));
    assert.deepEqual(parse('', 'empty.cjs', options), { exports: [], reexports: [] });
    assert.deepEqual(parse('exports.after = 1;', 'after.cjs'), { exports: ['after'], reexports: [] });
  });

  test('early scanner errors propagate in extended mode', () => {
    assert.throws(() => parse('}', 'broken.cjs', options),
      /** @param {Error} error */
      error => error.message.includes('broken.cjs'));
    assert.deepEqual(parse('exports.after = 1;', 'after.cjs', options),
      { exports: ['after'], reexports: [] });
  });

  test('default and explicit legacy mode preserve behavior', () => {
    const source = `Object.defineProperty(exports, 'name', ({ value: 1 })); exports.other = 2;`;
    assert.deepEqual(parse(source, 'fixture.cjs'), { exports: ['other'], reexports: [] });
    assert.deepEqual(parse(source, 'fixture.cjs', { mode: 'legacy' }), parse(source, 'fixture.cjs'));
    assert.deepEqual(parse(source, 'fixture.cjs', {}), parse(source, 'fixture.cjs'));
  });

  test('invalid modes fail at the API boundary', () => {
    assert.throws(() => parse('', 'fixture.cjs', { mode: 'unknown' }), { name: 'TypeError' });
  });

  test('invalid option values fail at the API boundary', () => {
    for (const value of [null, true, 'extended', [], { mode: false }]) {
      assert.throws(() => parse('', 'fixture.cjs', value), { name: 'TypeError' });
    }
  });

  test('mode is read once', () => {
    let reads = 0;
    const result = parse("Object.defineProperty(exports, 'name', descriptor);", 'fixture.cjs', {
      get mode() { reads++; return 'extended'; }
    });
    assert.equal(reads, 1);
    assert.deepEqual(result, { exports: ['name'], reexports: [] });
  });

  test('export targets and names must match', () => {
    assert.deepEqual(parse(`Object.defineProperty(other, 'name', { value: 1 });
      Object.defineProperty(exports, getName(), { value: 2 });
      Object.defineProperties(other, { name: { value: 3 } });
      Object.defineProperties(exports, dynamicDescriptors);`, 'fixture.cjs', options),
    { exports: [], reexports: [] });
  });

  test('extended bracket nesting boundaries', () => {
    assert.deepEqual(parse('['.repeat(2048) + '0' + ']'.repeat(2048), 'fixture.cjs', options),
      { exports: [], reexports: [] });
    assert.throws(() => parse('['.repeat(2049) + '0' + ']'.repeat(2049), 'fixture.cjs', options));
  });

  test('extended Wasm initializes on first use', async () => {
    const lexer = await import('../dist/lexer.mjs?extended-first-use');
    assert.deepEqual(lexer.parse("Object.defineProperty(exports, 'name', descriptor);", 'fixture.cjs', options),
      { exports: ['name'], reexports: [] });
  });

  test('browser source copying preserves extended names', async () => {
    const originalBuffer = global.Buffer;
    let lexer;
    global.Buffer = undefined;
    try {
      lexer = await import('../dist/lexer.mjs?extended-browser');
    }
    finally {
      global.Buffer = originalBuffer;
    }
    await lexer.init();
    assert.deepEqual(lexer.parse(`const text = '${'𓀀'.repeat(40000)}';
      Object.defineProperty(exports, 'name', ({ get: () => text }));`, 'fixture.cjs', options),
    { exports: ['name'], reexports: [] });
  });
});
