const assert = require('node:assert').strict;
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

let parse;

suite('Grouped reexports', () => {
  suiteSetup(async () => {
    if (process.env.WASM) {
      const lexer = await import('../dist/lexer.mjs');
      await lexer.init();
      parse = lexer.parse;
    } else if (process.env.WASM_SYNC) parse = require('../dist/lexer.js').parse;
    else parse = require('../lexer.js').parse;
  });

  test('groups conditional alternatives and drops overwritten dependencies by default', () => {
    assert.deepStrictEqual(parse("if (flag) module.exports = require('./a'); else module.exports = require('./b');"),
      { exports: [], reexports: [['./a'], ['./b']], complete: true });
    assert.deepStrictEqual(parse("module.exports = require('./a'); module.exports = require('./b');"),
      { exports: [], reexports: [['./b']], complete: true });
  });
  test('groups dependencies combined in a final object', () => {
    const source = "if (flag) module.exports = {...require('./a'), ...require('./b')}; " +
      "else module.exports = {...require('./c'), ...require('./d')};";
    assert.deepStrictEqual(parse(source), { exports: [], reexports: [['./a', './b'], ['./c', './d']], complete: true });
    assert.deepStrictEqual(parse(source.replace('flag', 'true')),
      { exports: [], reexports: [['./a', './b']], complete: true });
  });
  test('keeps the count gate and the explicit legacy baseline', () => {
    for (const source of ['', 'exports.name = 1;', "module.exports = require('./one');"]) {
      const result = parse(source);
      assert.equal(Object.prototype.hasOwnProperty.call(result, 'complete'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(result, 'analysis'), false);
    }
    assert.deepStrictEqual(parse("module.exports = {...require('./a'), ...require('./b')};").reexports,
      [['./a', './b']]);
    for (const extra of ['// module.exports = 2;', '/* module.exports = 2; */', "'module.exports = 2;'",
      'module.exports.name = 2;', 'module.exports === 2;', 'module.exports == 2;']) {
      assert.equal(Object.prototype.hasOwnProperty.call(parse('module.exports = {}; ' + extra), 'complete'), false);
    }
    const source = "if (true) module.exports = require('./a'); else module.exports = require('./b');";
    assert.deepStrictEqual(parse(source, '@', { baseline: 'legacy' }), { exports: [], reexports: ['./b'] });
    assert.deepStrictEqual(parse(source, '@', { baseline: 'flow-v1' }), parse(source));
  });
  test('reads the baseline once and returns plain snapshot values', () => {
    const source = "module.exports = require('./old'); module.exports = require('./final');";
    let reads = 0;
    const result = parse(source, '@', { get baseline () { reads++; return 'flow-v1'; } });
    assert.equal(reads, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'analysis'), false);
    assert.deepStrictEqual(Object.freeze(result).reexports, [['./final']]);
    result.reexports[0][0] = './mutated';
    assert.deepStrictEqual(parse(source).reexports, [['./final']]);
    assert.throws(() => parse('', '@', { baseline: 'future' }), { name: 'RangeError' });
    assert.throws(() => parse('', '@', { baseline: 1 }), { name: 'TypeError' });
  });
  test('marks filtered UTF-16 names and dependencies incomplete', () => {
    assert.deepStrictEqual(parse("module.exports = {}; module.exports = { '\\uD800': 1, valid: 1 };"),
      { exports: ['valid'], reexports: [], complete: false });
    assert.deepStrictEqual(parse("module.exports = {}; module.exports = require('./\\uD800');"),
      { exports: [], reexports: [], complete: false });
  });
  test('initializes the shared Wasm engine through CommonJS init', async () => {
    const rootPath = require.resolve('../lexer.js'), wasmPath = require.resolve('../dist/lexer.js');
    const rootModule = require.cache[rootPath], wasmModule = require.cache[wasmPath];
    const constructor = WebAssembly.Module;
    let calls = 0;
    delete require.cache[rootPath]; delete require.cache[wasmPath];
    try {
      const lexer = require('../lexer.js');
      WebAssembly.Module = function forbiddenSyncCompile () { calls++; throw new Error('Synchronous compilation'); };
      await lexer.init();
      assert.equal(calls, 0);
      assert.deepStrictEqual(lexer.parse("module.exports = require('./old'); module.exports = require('./final');")
        .reexports, [['./final']]);
      assert.equal(calls, 0);
    } finally {
      WebAssembly.Module = constructor;
      if (rootModule) require.cache[rootPath] = rootModule;
      else delete require.cache[rootPath];
      if (wasmModule) require.cache[wasmPath] = wasmModule;
      else delete require.cache[wasmPath];
    }
  });
  test('folds pure primitive guards, including escaped strings and typeof', () => {
    for (const condition of ['false', '0', "''", 'null', 'void 0', '!true', '1 === 2', "'a' === 'b'",
      "'\\x61' !== 'a'", "'\\u{61}' !== 'a'", "'\\141' !== 'a'", "'\\\r\n'", '0x0', '0b0', '0o0']) {
      const source = 'if (' + condition + ") module.exports = require('./dead'); else module.exports = require('./live');";
      assert.deepStrictEqual(parse(source), { exports: [], reexports: [['./live']], complete: true }, condition);
    }
    for (const condition of ['true', '1e2 === 100', '0.1 === 0.1', "typeof 1 === 'number'",
      "typeof typeof flag === 'string'", 'require', 'module', 'exports']) {
      const source = 'if (' + condition + ") module.exports = require('./live'); else module.exports = require('./dead');";
      assert.deepStrictEqual(parse(source).reexports, [['./live']], condition);
    }
    assert.deepStrictEqual(parse("module.exports = {}; module.exports = typeof flag ?? require('./dead');").reexports, []);
  });
  test('handles nested branches, ternaries, logical guards and logical assignments', () => {
    assert.deepStrictEqual(parse("if (first) { if (second) module.exports = require('./a'); " +
      "else module.exports = require('./b'); } else module.exports = require('./c');").reexports,
    [['./a'], ['./b'], ['./c']]);
    assert.deepStrictEqual(parse("module.exports = {}; module.exports = flag ? require('./a') : require('./b');").reexports,
      [['./a'], ['./b']]);
    for (const operator of ['&&', '||', '??']) {
      const result = parse("module.exports = {}; flag " + operator + " (module.exports = require('./active'));");
      assert.equal(result.complete, false);
      assert.deepStrictEqual(result.reexports, [['./active']]);
    }
    for (const [operator, initial] of [['&&=', 'true'], ['||=', 'false'], ['??=', 'null']]) {
      assert.deepStrictEqual(parse('module.exports = ' + initial + '; module.exports ' + operator +
        " require('./active');").reexports, [['./active']]);
    }
    assert.deepStrictEqual(parse("module.exports = require('./a'); module.exports ||= require('./b');").reexports,
      [['./a'], ['./b']]);
    assert.deepStrictEqual(parse("if (flag) module.exports = require('./a'); else module.exports = require('./b'); " +
      "module.exports = require('./final');").reexports, [['./final']]);
  });
  test('reports only surviving literal names and combined dependency spreads', () => {
    assert.deepStrictEqual(parse('module.exports = { removed: 1 }; module.exports = { final: 1 };'),
      { exports: ['final'], reexports: [], complete: true });
    assert.deepStrictEqual(parse('module.exports = {}; module.exports = { 0x10: 1, 1e2: 2, 1.5: 3, final: 0, final: 1 };'),
      { exports: ['16', '100', '1.5', 'final'], reexports: [], complete: true });
    assert.deepStrictEqual(parse("module.exports = {}; module.exports = { own: require('./value'), " +
      "...{ nested: 1, ...require('./spread') }, ...require('./spread') };"),
    { exports: ['own', 'nested'], reexports: [['./spread']], complete: true });
    assert.deepStrictEqual(parse("if (flag) module.exports = require('./same'); else module.exports = require(\"./same\");"),
      { exports: [], reexports: [['./same']], complete: true });
    assert.deepStrictEqual(parse("module.exports = {}; module.exports = { own: 1 }; " +
      "if (module.exports === module.exports) module.exports = require('./live'); else module.exports = require('./dead');")
      .reexports, [['./live']]);
  });
  test('does not guess across unsupported scopes, mutation, or dynamic spreads', () => {
    for (const middle of ['for (;;) { break; }', 'while (flag) {}', 'switch (flag) { case 1: break; }',
      'try {} catch (error) {}', 'const flag = true;', 'function unused() { module.exports = {}; }',
      'exports.detached = 1;', 'module.exports.detached = 1;', 'delete module.exports.name;',
      'module.exports = { ...foreign };', 'module.exports = { "__pro\\u0074o__": 1 };',
      'mutate();', 'return;', 'throw new Error();']) {
      assert.deepStrictEqual(parse('module.exports = {}; ' + middle + ' module.exports = {};'),
        { exports: [], reexports: [], complete: false }, middle);
    }
  });
  test('does not report a dependency after a CommonJS early return', () => {
    assert.deepStrictEqual(parse("module.exports = require('./before'); return; module.exports = require('./dead');"),
      { exports: [], reexports: [], complete: false });
  });
  test('invalidates exposed values after opaque reads or dependency execution', () => {
    for (const effect of ['flag;', 'flag.name;', "require('./effects');"]) {
      assert.deepStrictEqual(parse('module.exports = {}; module.exports = { previous: 1 }; ' + effect),
        { exports: [], reexports: [], complete: false });
    }
    assert.deepStrictEqual(parse('module.exports = { previous: 1 }; flag; module.exports = { fresh: 1 };'),
      { exports: ['fresh'], reexports: [], complete: true });
  });
  test('handles ECMAScript line terminators and semicolon insertion', () => {
    for (const line of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
      const before = 'module.exports = {}; module.exports = { before: 1 }';
      const after = 'module.exports = { after: 1 };';
      for (const source of [before + '; // comment' + line + after, before + line + after]) {
        assert.deepStrictEqual(parse(source), { exports: ['after'], reexports: [], complete: true });
      }
      if (line === '\n' || line === '\r' || line === '\r\n')
        assert.deepStrictEqual(parse('#!/usr/bin/env node' + line + before + '; ' + after),
          { exports: ['after'], reexports: [], complete: true });
    }
    assert.deepStrictEqual(parse('module.exports = {}; module.exports = { after: 1 }; // no line end'),
      { exports: ['after'], reexports: [], complete: true });
  });
  test('matches native dependency groups without executing conditions during analysis', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cjs-grouped-'));
    const filename = join(directory, 'entry.cjs');
    const requireFixture = createRequire(filename);
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'groupedFlowFlag');
    let calls = 0, enabled = true;
    Object.defineProperty(globalThis, 'groupedFlowFlag', {
      configurable: true, get () { calls++; return enabled; }
    });
    try {
      for (const name of ['a', 'b', 'c', 'd']) writeFileSync(join(directory, name + '.cjs'), 'exports.' + name + ' = 1;');
      const source = "if (groupedFlowFlag) module.exports = {...require('./a.cjs'), ...require('./b.cjs')}; " +
        "else module.exports = {...require('./c.cjs'), ...require('./d.cjs')};";
      writeFileSync(filename, source);
      const result = parse(source);
      assert.equal(calls, 0);
      assert.deepStrictEqual(result.reexports, [['./a.cjs', './b.cjs'], ['./c.cjs', './d.cjs']]);
      for (const flag of [true, false]) {
        enabled = flag;
        const observed = requireFixture(filename);
        delete requireFixture.cache[requireFixture.resolve(filename)];
        const group = result.reexports[flag ? 0 : 1];
        const keys = new Set();
        for (const dependency of group) for (const key of Object.keys(requireFixture(dependency))) keys.add(key);
        assert.deepStrictEqual(Object.keys(observed), [...keys]);
      }
      assert.equal(calls, 2);
      assert.equal(result.complete, true);
    } finally {
      for (const name of ['a', 'b', 'c', 'd']) {
        const dependency = join(directory, name + '.cjs');
        delete requireFixture.cache[requireFixture.resolve(dependency)];
      }
      if (previous) Object.defineProperty(globalThis, 'groupedFlowFlag', previous);
      else delete globalThis.groupedFlowFlag;
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test('rejects updates rather than certifying repeated unary operators', () => {
    for (const update of ['++module.exports', '--module.exports', 'module.exports++', 'module.exports--']) {
      const source = 'module.exports = 0; module.exports = 1; if (' + update +
        ' === 2) module.exports = { good: 1 }; else module.exports = { bad: 1 };';
      assert.deepStrictEqual(parse(source), { exports: [], reexports: [], complete: false }, update);
    }
    assert.deepStrictEqual(parse('module.exports = {}; module.exports = { good: + +1, other: - -1 };'),
      { exports: ['good', 'other'], reexports: [], complete: true });
  });
  test('rejects unsupported binary continuations across a line terminator', () => {
    for (const separator of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
      for (const operator of ['+', '-']) {
        const prefix = "module.exports = {}; module.exports = require('./n')";
        assert.deepStrictEqual(parse(prefix + separator + operator + '1;'),
          { exports: [], reexports: [], complete: false });
        assert.deepStrictEqual(parse(prefix + ';' + separator + operator + '1;'),
          { exports: [], reexports: [['./n']], complete: true });
      }
    }
    assert.deepStrictEqual(parse('module.exports = {}; module.exports = 1\n+ 1; ' +
      'if (module.exports === 2) module.exports = { good: 1 }; else module.exports = { bad: 1 };'),
    { exports: [], reexports: [], complete: false });
    for (const expression of ['1\nin\n{}', '1\ninstanceof\nObject']) {
      assert.deepStrictEqual(parse('module.exports = {}; module.exports = ' + expression + '; ' +
        'if (module.exports) module.exports = { good: 1 }; else module.exports = { bad: 1 };'),
      { exports: [], reexports: [], complete: false });
    }
  });
  test('bounds tokens, depth, work, and alternative count', () => {
    const prefix = 'module.exports = {}; module.exports = {};';
    assert.equal(parse(prefix + ';'.repeat(8192 - 14)).complete, true);
    assert.deepStrictEqual(parse(prefix + ';'.repeat(8193 - 14)),
      { exports: [], reexports: [], complete: false });
    assert.equal(parse(prefix + '('.repeat(62) + '1' + ')'.repeat(62) + ';').complete, true);
    assert.equal(parse(prefix + '('.repeat(63) + '1' + ')'.repeat(63) + ';').complete, false);
    assert.equal(parse(prefix + '// ' + 'x'.repeat(65454)).complete, true);
    assert.equal(parse(prefix + '// ' + 'x'.repeat(65455)).complete, false);
    /** @param {number} start @param {number} end */
    function alternatives (start, end) {
      if (end - start === 1) return "require('./" + start + "')";
      const middle = Math.floor((start + end) / 2);
      return '(flag ? ' + alternatives(start, middle) + ' : ' + alternatives(middle, end) + ')';
    }
    assert.equal(parse('module.exports = {}; module.exports = ' + alternatives(0, 32) + ';').reexports.length, 32);
    assert.deepStrictEqual(parse('module.exports = {}; module.exports = ' + alternatives(0, 33) + ';'),
      { exports: [], reexports: [], complete: false });
  });
});
