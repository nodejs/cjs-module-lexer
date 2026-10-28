const assert = require('node:assert/strict');

let parse;
const options = { mode: 'extended' };

suite('Extended parsing', () => {
  suiteSetup(async () => {
    if (process.env.NATIVE) {
      parse = require('./native/parser.js').parse;
      return;
    }
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

  test('published jest-watcher webpack modules', () => {
    // Extracts from jest-watcher@30.2.0/build/index.js (Meta Platforms, Inc., MIT).
    const source = `
      /***/ "./src/BaseWatchPlugin.ts":
      /***/ ((__unused_webpack_module, exports) => {
        Object.defineProperty(exports, "__esModule", ({
          value: true
        }));
        exports["default"] = void 0;
        class BaseWatchPlugin {}
        var _default = exports["default"] = BaseWatchPlugin;
      }),
      /***/ "./src/index.ts":
      /***/ ((__unused_webpack_module, exports, __webpack_require__) => {
        Object.defineProperty(exports, "__esModule", ({
          value: true
        }));
        Object.defineProperty(exports, "BaseWatchPlugin", ({
          enumerable: true,
          get: function () {
            return _BaseWatchPlugin.default;
          }
        }));
        var _BaseWatchPlugin = _interopRequireDefault(__webpack_require__("./src/BaseWatchPlugin.ts"));
      })
    `;
    assert.deepEqual(parse('({' + source + '});', 'jest-watcher.cjs'),
      { exports: ['default'], reexports: [] });
    assert.deepEqual(parse('({' + source + '});', 'jest-watcher.cjs', options),
      { exports: ['__esModule', 'default', 'BaseWatchPlugin'], reexports: [] });
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

  test('property names do not depend on descriptor comma expressions', () => {
    const result = parse(`Object.defineProperty(exports, 'name',
      ({ get() { throw new Error('unreachable'); } }, { value: 1 }));`, 'fixture.cjs', options);
    assert.deepEqual(result, { exports: ['name'], reexports: [] });
  });

  test('parenthesized comma expressions detect only the first object', () => {
    for (const source of [
      'module.exports = ({ a: 1 }, { b: 2 });',
      'Object.defineProperties(exports, ({ a: { value: 1 } }, { b: { value: 2 } }));',
      'Object.defineProperties(module.exports, ({ a: { value: 1 } }, { b: { value: 2 } }));'
    ]) {
      assert.deepEqual(parse(source, 'fixture.cjs', options), { exports: ['a'], reexports: [] });
      assert.deepEqual(parse(source, 'fixture.cjs'), { exports: [], reexports: [] });
    }
  });

  test('regex after labelled and nested statement blocks', () => {
    for (const block of [
      'a: {}', 'a: b: {}', 'a /* label */ : {}', '/**/ a: {}', 'a/**//**/: {}', '0; a: {}', '{} a: {}',
      'function run() { a: {}', '{ a: {}', 'if (x) a: {}', '{}', '{ {}', 'α: {}', '𐀀: {}'
    ]) {
      const suffix = block === 'function run() { a: {}' || block === '{ a: {}' || block === '{ {}' ? '}' : '';
      const source = block + String.raw` /[\]]exports.fake = 1/.test(x); exports.z = 1;` + suffix;
      assert.deepEqual(parse(source, 'labelled.cjs', options), { exports: ['z'], reexports: [] });
      assert.deepEqual(parse('exports.after = 1;', 'after.cjs', options),
        { exports: ['after'], reexports: [] });
    }
  });

  test('regex after simple switch case blocks', () => {
    for (const value of [
      'name', 'α', '𐀀', 'true', 'null', '1', '-1', '+1', '1n', '0xFF', '1_000',
      "''", "'text'", '"text"', String.raw`'it\'s'`, String.raw`"a\\"`, 'name /* value */'
    ]) {
      const source = `switch (value) { case ${value}: label: {}` +
        String.raw` /[\]]exports.fake = 1/.test(value); exports.z = 1; }`;
      assert.deepEqual(parse(source, 'switch.cjs', options), { exports: ['z'], reexports: [] });
    }
    assert.deepEqual(parse(String.raw`switch (value) { default: {} /[\]]/.test(value); exports.z = 1; }`,
      'switch.cjs', options), { exports: ['z'], reexports: [] });
  });

  test('comma expressions can skip leading simple operands', () => {
    for (const prefix of [
      '0', '1n', '0xFF', 'ignored', 'α', '𐀀', 'null', 'true', "'exports.fake = 1,'", '{}', '{ /* empty */ }',
      '0, ignored, "text"', '0, (ignored', '0 /* comma */, {}'
    ]) {
      const suffix = prefix === '0, (ignored' ? ')' : '';
      for (const source of [
        `module.exports = (${prefix}, { name: 1 }${suffix});`,
        `Object.defineProperties(exports, (${prefix}, { name: { value: 1 } }${suffix}));`,
        `Object.defineProperties(module.exports, (${prefix}, { name: { value: 1 } }${suffix}));`
      ]) {
        assert.deepEqual(parse(source, 'comma.cjs', options), { exports: ['name'], reexports: [] });
        assert.deepEqual(parse(source, 'comma.cjs'), { exports: [], reexports: [] });
      }
    }
    assert.deepEqual(parse("module.exports = (0, require('dep'));", 'comma.cjs', options),
      { exports: [], reexports: ['dep'] });
  });

  test('comma operands outside grouping and compound prefixes remain separate', () => {
    for (const source of [
      'module.exports = 0, { fake: 1 };',
      'Object.defineProperties(exports, 0, { fake: { value: 1 } });',
      'module.exports = (ignored + 1, { fake: 1 });',
      'module.exports = (call(), { fake: 1 });',
      'module.exports = ("exports.fake = 1");', 'module.exports = (0);',
      'module.exports = (/exports.fake = 1/, { fake: 1 });',
      'module.exports = (`exports.fake = 1`, { fake: 1 });'
    ]) {
      assert.deepEqual(parse(source + ' exports.after = 1;', 'comma.cjs', options),
        { exports: ['after'], reexports: [] });
    }
    assert.deepEqual(parse('module.exports = (exports.before = 1, { fake: 1 });', 'comma.cjs', options),
      { exports: ['before'], reexports: [] });
  });

  test('object and conditional expressions followed by division remain expressions', () => {
    for (const expression of [
      '{} / 2', '{ a: {} / 2 }', 'condition ? value : {} / 2',
      'condition ? left ? first : second : {} / 2', '({ label: {} / 2 })',
      '({ label: {} / /exports.fake = 1/.test(x) })',
      '({ "label": {} / 2 })', '({ [label]: {} / 2 })', '({ case: {} / 2 })',
      'condition ? 12 : {} / 2', 'condition ? -12 : {} / 2', 'condition ? +12 : {} / 2',
      'condition ? "text" : {} / 2', 'condition ? object.case : {} / 2'
    ]) {
      assert.deepEqual(parse(`const value = ${expression}; exports.z = 1;`, 'division.cjs', options),
        { exports: ['z'], reexports: [] });
    }
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

  test('default and explicit default mode preserve behavior', () => {
    const source = `Object.defineProperty(exports, 'name', ({ value: 1 })); exports.other = 2;`;
    assert.deepEqual(parse(source, 'fixture.cjs'), { exports: ['other'], reexports: [] });
    assert.deepEqual(parse(source, 'fixture.cjs', { mode: 'default' }), parse(source, 'fixture.cjs'));
    assert.deepEqual(parse(source, 'fixture.cjs', {}), parse(source, 'fixture.cjs'));
  });

  test('invalid modes fail at the API boundary', () => {
    assert.throws(() => parse('', 'fixture.cjs', { mode: 'unknown' }), { name: 'TypeError' });
  });

  test('existing option values preserve default detection', () => {
    for (const value of [null, true, 'extended', []]) {
      assert.deepEqual(parse('exports.name = 1;', 'fixture.cjs', value),
        { exports: ['name'], reexports: [] });
    }
    assert.throws(() => parse('', 'fixture.cjs', { mode: false }), { name: 'TypeError' });
  });

  test('mode is read once', () => {
    let reads = 0;
    const result = parse("Object.defineProperty(exports, 'name', descriptor);", 'fixture.cjs', {
      get mode() { reads++; return 'extended'; }
    });
    assert.equal(reads, 1);
    assert.deepEqual(result, { exports: ['name'], reexports: [] });
  });

  test('detection options compose and reset independently', () => {
    const source = `
      Object.defineProperty(exports, 'extended', ({ value: 1 }));
      Object.defineProperty(exports, 'minified', { enumerable: !0, value: 1 });
      var external = require('external');
      Object.keys(external).forEach(function (key) {
        if (key === 'default' || key === '__esModule') return;
        Object.defineProperty(exports, key, {
          enumerable: !0, get: function () { return external[key]; }
        });
      });
    `;
    for (const mode of [undefined, 'default', 'extended']) {
      for (const allowMinifiedEnumerable of [false, true]) {
        const combined = { mode, allowMinifiedEnumerable };
        const names = mode === 'extended' ? ['extended', 'minified'] :
          allowMinifiedEnumerable ? ['minified'] : [];
        assert.deepEqual(parse(source, 'fixture.cjs', combined), {
          exports: names, reexports: allowMinifiedEnumerable ? ['external'] : []
        });
        assert.throws(() => parse('(', 'broken.cjs', combined), /broken\.cjs/);
        assert.deepEqual(parse(source, 'fixture.cjs'), { exports: [], reexports: [] });
      }
    }
  });

  test('option getters can reenter either parsing mode', () => {
    const source = "Object.defineProperty(exports, 'outer', ({ value: 1 }));";
    for (const mode of ['default', 'extended']) {
      for (const nested of ['exports.inner = 1;', '('.repeat(2049)]) {
        let reads = 0;
        const combined = {
          get mode () {
            reads++;
            if (nested.startsWith('(')) {
              assert.throws(() => parse(nested, 'nested.cjs', options), /nested\.cjs/);
            } else {
              parse(nested, 'nested.cjs', options);
            }
            return mode;
          },
          get allowMinifiedEnumerable () {
            parse('exports.inner = 1;', 'nested.cjs', options);
            return true;
          }
        };
        assert.deepEqual(parse(source, 'fixture.cjs', combined), {
          exports: mode === 'extended' ? ['outer'] : [], reexports: []
        });
        assert.equal(reads, 1);
      }
    }
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
