const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { createRequire } = require('node:module');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

/** @typedef {import('../lexer').ExportAnalysis['outcomes'][number]} FlowOutcome */
let parse;
/** @param {string} source */
function analysis (source) { return parse(source, 'fixture.cjs', { baseline: 'flow-v1' }); }
/** @param {import('../lexer').ExportAnalysis} report */
function values (report) { return report.outcomes.map(/** @param {FlowOutcome} outcome */ outcome => outcome.value); }

suite('Replacement flow heuristic', () => {
  suiteSetup(async () => {
    if (process.env.WASM) {
      const lexer = await import('../dist/lexer.mjs');
      await lexer.init();
      parse = lexer.parse;
    } else if (process.env.WASM_SYNC) parse = require('../dist/lexer.js').parse;
    else parse = require('../lexer.js').parse;
  });

  test('does not activate for zero or one detected replacement', () => {
    for (const source of ['', 'exports.name = 1;', "module.exports = require('./one');",
      "if (false) module.exports = require('./one');", "module.exports = flag ? require('./a') : require('./b');"]) {
      assert.equal(Object.hasOwn(parse(source), 'analysis'), false);
      assert.deepStrictEqual(values(analysis(source)), [{ kind: 'unknown', reason: 'insufficient-replacements' }]);
    }
  });
  test('counts lexer detections, excluding comments, strings, properties, and comparisons', () => {
    for (const extra of ['// module.exports = 2;', '/* module.exports = 2; */', "'module.exports = 2;'",
      'module.exports.name = 2;', 'module.exports["name"] = 2;', 'module.exports === 2;', 'module.exports == 2;']) {
      assert.equal(Object.hasOwn(parse('module.exports = {}; ' + extra), 'analysis'), false);
    }
    assert.equal(Object.hasOwn(parse('module /* gap */ . exports = {}; module.exports = {};'), 'analysis'), true);
  });
  test('matches native line terminators in comments, hashbangs, and semicolon insertion', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cjs-flow-lines-'));
    const filename = join(directory, 'entry.cjs');
    const requireFixture = createRequire(filename);
    try {
      for (const line of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
        const before = 'module.exports = {}; module.exports = { before: 1 }';
        const after = 'module.exports = { after: 1 };';
        for (const source of [before + '; // comment' + line + after, before + line + after,
          '#!/usr/bin/env node' + line + before + '; ' + after]) {
          writeFileSync(filename, source);
          const observed = requireFixture(filename);
          delete requireFixture.cache[requireFixture.resolve(filename)];
          assert.deepStrictEqual(Object.keys(observed), ['after']);
          const result = parse(source);
          const report = analysis(source);
          if (source.startsWith('#!') && (line === '\u2028' || line === '\u2029')) {
            assert.equal(Object.hasOwn(result, 'analysis'), false);
            assert.deepStrictEqual(values(report), [{ kind: 'unknown', reason: 'insufficient-replacements' }]);
          } else {
            assert.equal(report.complete, true, JSON.stringify(source));
            assert.deepStrictEqual(values(report), [{ kind: 'object', properties: Object.keys(observed) }]);
            assert.deepStrictEqual(result.analysis, report);
          }
        }
      }
      const end = 'module.exports = {}; module.exports = { after: 1 }; // no terminator';
      assert.deepStrictEqual(values(analysis(end)), [{ kind: 'object', properties: ['after'] }]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test('default analysis preserves legacy enumeration and serialization', () => {
    const source = "if (true) module.exports = require('./a'); else module.exports = require('./b');";
    const expected = { exports: [], reexports: ['./b'] };
    const result = parse(source);
    assert.equal(Object.getOwnPropertyDescriptor(result, 'analysis').enumerable, false);
    assert.deepStrictEqual(result, expected);
    assert.equal(JSON.stringify(result), JSON.stringify(expected));
    assert.deepStrictEqual(values(result.analysis), [{ kind: 'module', specifier: './a' }]);
    assert.deepStrictEqual(parse(source, '@', {}), expected);
    const legacy = parse(source, '@', { baseline: 'legacy' });
    assert.equal(Object.hasOwn(legacy, 'analysis'), false);
    assert.deepStrictEqual(legacy, expected);
  });
  test('defers and caches reports across interleaved parses and result mutation', () => {
    const source = "module.exports = require('./old'); module.exports = require('./final');";
    const result = parse(source);
    assert.equal(typeof Object.getOwnPropertyDescriptor(result, 'analysis').get, 'function');
    result.reexports[0] = './mutated';
    parse('module.exports = {}; module.exports = { other: 1 };');
    const report = result.analysis;
    assert.equal(Object.getOwnPropertyDescriptor(result, 'analysis').get, undefined);
    assert.equal(result.analysis, report);
    assert.deepStrictEqual(values(report), [{ kind: 'module', specifier: './final' }]);
  });
  test('validates the versioned third argument', () => {
    assert.throws(() => parse('', '@', { baseline: 'future' }), {
      name: 'RangeError', message: 'Unknown detection baseline: future'
    });
    assert.throws(() => parse('', '@', { baseline: 1 }), {
      name: 'TypeError', message: 'Detection baseline must be a string'
    });
  });
  test('reads the baseline once before lexing', () => {
    const source = "if (flag) module.exports = require('./a'); else module.exports = require('./b');";
    for (const baseline of [undefined, 'legacy', 'flow-v1']) {
      let reads = 0;
      parse(source, '@', { get baseline () { reads++; return baseline; } });
      assert.equal(reads, 1);
    }
  });
  test('reports only the last sequential replacement', () => {
    assert.deepStrictEqual(values(analysis("module.exports = require('./a'); module.exports = require('./b');")),
      [{ kind: 'module', specifier: './b' }]);
    assert.deepStrictEqual(values(analysis('module.exports = { removed: 1 }; module.exports = { final: 1 };')),
      [{ kind: 'object', properties: ['final'] }]);
    for (const source of ["module.exports = require('old'); module.exports = require(\"new'quote\");",
      "module.exports = require('old'); module.exports = require('new\\'quote');"]) {
      assert.deepStrictEqual(values(analysis(source)), [{ kind: 'module', specifier: "new'quote" }]);
    }
    for (const length of [4096, 4097]) {
      const source = "module.exports = require('./a'); module.exports = require('./b');";
      assert.deepStrictEqual(values(analysis(source.padEnd(length))), [{ kind: 'module', specifier: './b' }]);
    }
  });
  test('preserves conditional alternatives with source ranges', () => {
    const report = analysis("if (flag) module.exports = require('./a'); else module.exports = require('./b');");
    assert.equal(report.complete, true);
    assert.deepStrictEqual(values(report), [{ kind: 'module', specifier: './a' }, { kind: 'module', specifier: './b' }]);
    assert.deepStrictEqual(report.outcomes.map(/** @param {FlowOutcome} outcome */ outcome => outcome.conditions[0]),
      [{ start: 4, end: 8, when: 'truthy' }, { start: 4, end: 8, when: 'falsy' }]);
    const nested = "if (first) { if (second) module.exports = require('./a'); " +
      "else module.exports = require('./b'); } else module.exports = require('./c');";
    assert.equal(analysis(nested).outcomes.length, 3);
    for (const value of values(analysis(nested + " module.exports = require('./final');"))) {
      assert.deepStrictEqual(value, { kind: 'module', specifier: './final' });
    }
  });
  test('handles ternaries and logical conditions after the trigger', () => {
    assert.deepStrictEqual(values(analysis("module.exports = {}; module.exports = flag ? require('./a') : require('./b');")),
      [{ kind: 'module', specifier: './a' }, { kind: 'module', specifier: './b' }]);
    for (const [operator, when] of [['&&', 'truthy'], ['||', 'falsy'], ['??', 'nullish']]) {
      const result = analysis("module.exports = {}; flag " + operator + " (module.exports = require('./active'));");
      assert.equal(result.complete, false);
      const active = result.outcomes.find(/** @param {FlowOutcome} outcome */ outcome => outcome.value.kind === 'module');
      assert.equal(active.conditions[0].when, when);
    }
  });
  test('counts and handles logical replacement assignments', () => {
    for (const [operator, initial] of [['&&=', 'true'], ['||=', 'false'], ['??=', 'null']]) {
      const source = 'module.exports = ' + initial + '; module.exports ' + operator + " require('./active');";
      assert.equal(Object.hasOwn(parse(source), 'analysis'), true);
      assert.deepStrictEqual(values(analysis(source)), [{ kind: 'module', specifier: './active' }]);
    }
    assert.equal(analysis("module.exports = require('./a'); module.exports ||= require('./b');").complete, false);
  });
  test('folds pure primitive conditions and normalizes literal keys', () => {
    for (const condition of ['false', '0', "''", 'null', 'void 0', '!true', '1 === 2']) {
      assert.deepStrictEqual(values(analysis('if (' + condition + ") module.exports = require('./dead'); " +
        "else module.exports = require('./live');")), [{ kind: 'module', specifier: './live' }]);
    }
    assert.deepStrictEqual(values(analysis('module.exports = {}; ' +
      'module.exports = { 0x10: 1, 1e2: 2, 1.5: 3, final: 0, final: 1 };')),
      [{ kind: 'object', properties: ['16', '100', '1.5', 'final'] }]);
  });
  test('does not guess exports across unsupported effects, bindings, or control flow', () => {
    for (const middle of ['for (;;) { break; }', 'while (flag) {}', 'switch (flag) { case 1: break; }',
      'try {} catch (error) {}', 'const flag = true;', 'function unused() { module.exports = {}; }',
      'exports.detached = 1;', 'module.exports.detached = 1;', 'delete module.exports.name;',
      'module.exports = { ...require("./spread") };', 'mutate();', 'return;', 'throw new Error();']) {
      const report = analysis('module.exports = {}; ' + middle + ' module.exports = {};');
      assert.equal(report.complete, false, middle);
      for (const value of values(report)) assert.equal(value.kind, 'unknown', middle);
    }
  });
  test('invalidates earlier values after opaque reads and dependency execution', () => {
    for (const expression of ['flag;', 'flag + 1;', 'flag.name;', "require('./effects');"]) {
      const report = analysis('module.exports = {}; module.exports = { previous: 1 }; ' + expression);
      assert.equal(report.complete, false);
      for (const value of values(report)) assert.equal(value.kind, 'unknown');
    }
  });
  test('matches native exports without executing conditions during analysis', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cjs-replacement-flow-'));
    const filename = join(directory, 'entry.cjs');
    const requireFixture = createRequire(filename);
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'flowPocCondition');
    let calls = 0;
    Object.defineProperty(globalThis, 'flowPocCondition', { configurable: true, get () { calls++; return true; } });
    try {
      const source = 'if (flowPocCondition) module.exports = { actual: 1 }; else module.exports = { other: 1 };';
      writeFileSync(filename, source);
      const report = analysis(source);
      assert.equal(calls, 0);
      const observed = requireFixture(filename);
      assert.equal(calls, 1);
      assert.deepStrictEqual(Object.keys(observed), report.outcomes[0].value.properties);
      delete requireFixture.cache[requireFixture.resolve(filename)];
    } finally {
      if (previous) Object.defineProperty(globalThis, 'flowPocCondition', previous);
      else delete globalThis.flowPocCondition;
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test('bounds tokens, outcomes, and AST depth', () => {
    const prefix = 'module.exports = {}; module.exports = {};';
    assert.equal(analysis(prefix + ';'.repeat(8192 - 14)).complete, true);
    assert.equal(values(analysis(prefix + ';'.repeat(8193 - 14)))[0].reason, 'token-limit');
    for (const expression of ['1' + '+1'.repeat(1000), 'flag' + '.name'.repeat(1000),
      'require("./a")' + '()'.repeat(1000)]) {
      assert.equal(values(analysis(prefix + expression + ';'))[0].reason, 'depth-limit');
    }
    const branch = 'if (flag) module.exports = {}; else module.exports = {};';
    assert.equal(analysis(branch.repeat(5)).outcomes.length, 32);
    assert.equal(values(analysis(branch.repeat(6)))[0].reason, 'outcome-limit');
  });
});
