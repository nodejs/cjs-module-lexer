const assert = require('node:assert/strict');

let parse;
const options = { mode: 'conservative' };

suite('Conservative parsing', () => {
  suiteSetup(async () => {
    if (process.env.WASM) {
      const lexer = await import('../dist/lexer.mjs');
      await lexer.init();
      parse = lexer.parse;
    }
    else if (process.env.WASM_SYNC) {
      const lexer = require('../dist/lexer.js');
      lexer.initSync();
      parse = lexer.parse;
    }
    else {
      parse = require('../lexer.js').parse;
    }
  });

  test('object values and methods can contain arbitrary expressions', () => {
    const source = `module.exports = {
      value: call({ nested: [1, 2] }),
      method() { return /[,}]/.test('}'); },
      async task() { return await work(); },
      *sequence() { yield 1; },
      async *stream() { yield await work(); },
      ['computed']: \`value \${call({ nested: 1 })}\`,
      shorthand,
      [dynamic]: ignored
    };`;
    assert.deepEqual(parse(source, 'fixture.cjs', options), {
      exports: ['value', 'method', 'task', 'sequence', 'stream', 'computed', 'shorthand'], reexports: []
    });
  });

  for (const [name, accessor] of [
    ['value', 'get value() { throw effect(); }'],
    ['value', 'set value(input) { effect(input); }'],
    ['value', 'get ["value"]() { return effect(); }'],
    ['value', 'get "value"() { return effect(); }'],
    ['value', 'get ["\\u0076alue"]() { return effect(); }'],
    ['', 'get [""]() { return effect(); }']
  ]) {
    test(`accessor veto: ${accessor}`, () => {
      const result = parse(`exports["${name}"] = 1; module.exports = { ${accessor}, kept: 1 };`, 'fixture.cjs', options);
      assert.equal(result.exports.includes(name), false);
      assert.deepEqual(result, { exports: ['kept'], reexports: [] });
    });
  }

  for (const [name, key] of [
    ['123', '123'],
    ['123', '0x7b'],
    ['100', '1e2'],
    ['123', '[123]'],
    ['value', '[computed]']
  ]) {
    test(`unrecognized accessor key retains prior candidates: ${key}`, () => {
      const source = `exports["${name}"] = 1; module.exports = { get ${key}() { throw effect(); }, kept: call() };`;
      assert.equal(parse(source).exports.includes(name), true);
      assert.deepEqual(parse(source, 'fixture.cjs', options), { exports: [name, 'kept'], reexports: [] });
    });
  }

  test('get, set and async remain ordinary property and method names', () => {
    assert.deepEqual(parse('module.exports = { get: call(), set() {}, async, ["get"]: 1 };', 'fixture.cjs', options),
      { exports: ['get', 'set', 'async'], reexports: [] });
  });

  test('arbitrary defineProperty getters veto a previously detected name', () => {
    const result = parse(`exports.value = 1;
      Object.defineProperty(exports, 'value', { get() { return effect(); } });
      Object.defineProperty(exports, 'kept', { value: call() });`, 'fixture.cjs', options);
    assert.equal(result.exports.includes('value'), false);
    assert.deepEqual(result, { exports: ['kept'], reexports: [] });
  });

  test('forwarding getters retain the default allowlist', () => {
    assert.deepEqual(parse(`Object.defineProperty(exports, 'forwarded', {
      enumerable: true, get: function() { return dependency.value; }
    });`, 'fixture.cjs', options), { exports: ['forwarded'], reexports: [] });
  });

  test('dynamic descriptors and descriptor maps do not add names', () => {
    const result = parse(`Object.defineProperty(exports, 'dynamic', descriptor);
      Object.defineProperties(exports, { mapped: { get() { return effect(); } } });`, 'fixture.cjs', options);
    assert.deepEqual(result, { exports: [], reexports: [] });
  });

  for (const replacement of ["require('last')", '{ current: call() }', 'unknown', '({ old: 1 }, { current: 2 })']) {
    test(`replacement discards superseded reexports: ${replacement}`, () => {
      const result = parse(`module.exports = require('first'); module.exports = ${replacement};`, 'fixture.cjs', options);
      assert.equal(result.reexports.includes('first'), false);
      assert.deepEqual(result.reexports, replacement === "require('last')" ? ['last'] : []);
    });
  }

  test('spreads contribute reexports and named require values do not', () => {
    assert.deepEqual(parse(`module.exports = { ...require('spread'), value: require('value') };`, 'fixture.cjs', options),
      { exports: ['value'], reexports: ['spread'] });
  });

  for (const expression of ['({ old: 1 }, { current: 2 })', '({ current: 2 })', '(prefix, { current: 2 })']) {
    test(`parenthesized expressions do not add uncertain names: ${expression}`, () => {
      const result = parse(`module.exports = ${expression};`, 'fixture.cjs', options);
      assert.equal(result.exports.includes('old'), false);
      assert.deepEqual(result, { exports: [], reexports: [] });
    });
  }

  test('near-miss descriptor call names do not add exports', () => {
    const source = `Object.definePropert(exports, 'short', { value: 1 });
      Object.definePropertie(exports, 'almost', { value: 1 });
      Object.definePropertyExtra(exports, 'long', { value: 1 });
      Object.definePropertiesExtra(exports, { mapped: { value: 1 } });`;
    for (const mode of ['conservative', 'extended']) {
      assert.deepEqual(parse(source, 'fixture.cjs', { mode }), { exports: [], reexports: [] });
    }
  });

  test('minified enumerable remains a separate option', () => {
    const source = "Object.defineProperty(exports, 'value', { enumerable: !0, value: 1 });";
    assert.deepEqual(parse(source, 'fixture.cjs', options), { exports: [], reexports: [] });
    assert.deepEqual(parse(source, 'fixture.cjs', { ...options, allowMinifiedEnumerable: true }),
      { exports: ['value'], reexports: [] });
  });

  test('astral identifier starts reach the end of the Unicode table', () => {
    const names = [];
    let source = '';
    for (const code of [0x10000, 0x20000, 0x3134a]) {
      const name = String.fromCodePoint(code);
      names.push(name);
      source += `exports.${name} = 1;`;
    }
    for (const mode of ['default', 'extended', 'conservative']) {
      assert.deepEqual(parse(source, 'fixture.cjs', { mode }), { exports: names, reexports: [] });
    }
  });

  test('mode and getter veto state do not leak between calls', () => {
    const source = 'module.exports = { get value() { return effect(); }, kept: call() };';
    assert.deepEqual(parse(source, 'fixture.cjs', options), { exports: ['kept'], reexports: [] });
    assert.deepEqual(parse(source, 'fixture.cjs', { mode: 'extended' }), { exports: ['value', 'kept'], reexports: [] });
    assert.deepEqual(parse('exports.value = 1;', 'fixture.cjs', options), { exports: ['value'], reexports: [] });
    assert.deepEqual(parse(source), parse(source, 'fixture.cjs', { mode: 'default' }));
  });
});
