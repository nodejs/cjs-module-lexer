const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { createRequire } = require('node:module');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

/** @typedef {import('../lexer').ExportAnalysis['outcomes'][number]} FlowOutcome */

let parse;

/** @param {string} source */
function analysis (source) {
  return parse(source, 'fixture.cjs', { baseline: 'flow-v1' });
}

/** @param {string} source @param {(getExports: () => Record<string, unknown>) => unknown} effect */
function observeFlowSource (source, effect) {
  const directory = mkdtempSync(join(tmpdir(), 'cjs-flow-effect-'));
  const filename = join(directory, 'entry.cjs');
  writeFileSync(filename, source);
  const requireFixture = createRequire(filename);
  const cacheKey = requireFixture.resolve(filename);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'flowPocCondition');
  const getExports = () => requireFixture.cache[cacheKey].exports;
  let calls = 0;
  Object.defineProperty(globalThis, 'flowPocCondition', {
    configurable: true,
    get () {
      calls++;
      return effect(getExports);
    }
  });
  try {
    const report = analysis(source);
    assert.equal(calls, 0);
    const observed = requireFixture(filename);
    assert.equal(calls, 1);
    return { report, observed };
  } finally {
    if (previous) Object.defineProperty(globalThis, 'flowPocCondition', previous);
    else delete globalThis.flowPocCondition;
    delete requireFixture.cache[cacheKey];
    rmSync(directory, { recursive: true, force: true });
  }
}

suite('Flow detection baseline', () => {
  suiteSetup(async () => {
    if (process.env.WASM) {
      const lexer = await import('../dist/lexer.mjs');
      await lexer.init();
      parse = lexer.parse;
    } else if (process.env.WASM_SYNC) {
      parse = require('../dist/lexer.js').parse;
    } else {
      parse = require('../lexer.js').parse;
    }
  });

  test('default and explicit legacy results retain their exact shape', () => {
    const source = "if (true) module.exports = require('./a'); else module.exports = require('./b');";
    const expected = { exports: [], reexports: ['./b'] };
    assert.deepStrictEqual(parse(source), expected);
    assert.deepStrictEqual(parse(source, 'fixture.cjs', {}), expected);
    assert.deepStrictEqual(parse(source, 'fixture.cjs', { baseline: 'legacy' }), expected);
  });

  test('rejects an unknown baseline', () => {
    assert.throws(() => parse('', 'fixture.cjs', { baseline: 'future' }), {
      name: 'RangeError', message: 'Unknown detection baseline: future'
    });
  });

  test('the issue reproduction reports the reachable export', () => {
    const result = analysis("if (true) module.exports = require('./a'); else module.exports = require('./b');");
    assert.equal(result.baseline, 'flow-v1');
    assert.equal(result.complete, true);
    assert.deepStrictEqual(result.outcomes, [{ conditions: [], value: { kind: 'module', specifier: './a' } }]);
  });

  test('unknown conditions preserve both final alternatives', () => {
    const result = analysis("if (flag) module.exports = require('./a'); else module.exports = require('./b');");
    assert.equal(result.complete, true);
    assert.deepStrictEqual(result.outcomes.map(/** @param {FlowOutcome} outcome */ outcome => outcome.value), [
      { kind: 'module', specifier: './a' }, { kind: 'module', specifier: './b' }
    ]);
    assert.deepStrictEqual(result.outcomes.map(
      /** @param {FlowOutcome} outcome */ outcome => outcome.conditions[0].when
    ), ['truthy', 'falsy']);
  });

  test('later replacements remove all earlier module sources', () => {
    for (const prefix of ["module.exports = require('./a');", "if (flag) module.exports = require('./a');"]) {
      const result = analysis(prefix + " module.exports = require('./b');");
      assert.equal(result.complete, true);
      for (const outcome of result.outcomes) {
        assert.deepStrictEqual(outcome.value, { kind: 'module', specifier: './b' });
      }
    }
    assert.deepStrictEqual(analysis("module.exports = require('./a'); module.exports = {};").outcomes[0].value,
      { kind: 'object', properties: [] });
  });

  test('retains the unchanged outcome when there is no else', () => {
    const result = analysis("if (flag) module.exports = require('./a');");
    assert.deepStrictEqual(result.outcomes.map(/** @param {FlowOutcome} outcome */ outcome => outcome.value), [
      { kind: 'module', specifier: './a' }, { kind: 'unknown', reason: 'opaque-read-effects' }
    ]);
  });

  test('ternaries and short-circuit assignments preserve alternatives', () => {
    const conditional = analysis("module.exports = flag ? require('./a') : require('./b');");
    assert.deepStrictEqual(conditional.outcomes.map(
      /** @param {FlowOutcome} outcome */ outcome => outcome.value.specifier
    ), ['./a', './b']);
    for (const [operator, conditions, active] of [['&&', ['truthy', 'falsy'], 0], ['||', ['truthy', 'falsy'], 1],
      ['??', ['nullish', 'non-nullish'], 0]]) {
      const result = analysis("flag " + operator + " (module.exports = require('./a'));");
      assert.deepStrictEqual(result.outcomes.map(
        /** @param {FlowOutcome} outcome */ outcome => outcome.conditions[0].when
      ), conditions);
      assert.deepStrictEqual(result.outcomes[active].value, { kind: 'module', specifier: './a' });
      assert.deepStrictEqual(result.outcomes[1 - active].value, { kind: 'unknown', reason: 'opaque-read-effects' });
    }
  });

  test('folds constants with JavaScript truthiness and nullish semantics', () => {
    for (const condition of ['false', '0', "''", 'null', 'void 0', '!true', '1 === 2']) {
      assert.deepStrictEqual(analysis('if (' + condition + ") module.exports = require('./dead');").outcomes,
        [{ conditions: [], value: { kind: 'object', properties: [] } }]);
    }
    for (const condition of ['true', '1', "'x'", '!false', '1 === 1']) {
      assert.deepStrictEqual(analysis('if (' + condition + ") module.exports = require('./live');").outcomes[0].value,
        { kind: 'module', specifier: './live' });
    }
    assert.deepStrictEqual(analysis("0 ?? (module.exports = require('./dead'));").outcomes[0].value,
      { kind: 'object', properties: [] });
  });

  test('tracks local values, reassignment, and correlated tests', () => {
    assert.deepStrictEqual(analysis("let flag = false; flag = true; if (flag) module.exports = require('./a');")
      .outcomes[0].value, { kind: 'module', specifier: './a' });
    const result = analysis("const flag = require('./flag'); module.exports = {}; " +
      "if (flag) { if (!flag) module.exports = require('./dead'); }");
    assert.equal(result.complete, true);
    for (const outcome of result.outcomes) {
      assert.deepStrictEqual(outcome.value, { kind: 'object', properties: [] });
    }
    const shadowed = analysis("const flag = false; { let flag = false; flag = true; " +
      "if (flag) exports.live = 1; } if (flag) exports.dead = 1;");
    assert.equal(shadowed.complete, true);
    assert.deepStrictEqual(shadowed.outcomes[0].value, { kind: 'object', properties: ['live'] });
  });

  test('tracks object identity and detached aliases', () => {
    assert.deepStrictEqual(analysis("const target = exports; target.live = 1; exports = {}; exports.dead = 2;")
      .outcomes[0].value, { kind: 'object', properties: ['live'] });
    assert.deepStrictEqual(analysis('module.exports = {live: 1}; exports.dead = 1;').outcomes[0].value,
      { kind: 'object', properties: ['live'] });
    const effects = analysis("module.exports = require('./a'); exports.dead = 1;");
    assert.equal(effects.complete, false);
    assert.equal(effects.outcomes[0].value.kind, 'unknown');
    assert.equal(effects.outcomes[0].value.reason, 'dependency-effects');
    assert.deepStrictEqual(analysis('module.exports = exports = {}; exports.live = 1;').outcomes[0].value,
      { kind: 'object', properties: ['live'] });
  });

  test('named require values do not become whole-module reexports', () => {
    assert.deepStrictEqual(analysis("module.exports = { dep: require('./a') };").outcomes[0].value,
      { kind: 'object', properties: ['dep'] });
  });

  test('ignores overwritten, deleted, and uninvoked exports', () => {
    assert.deepStrictEqual(analysis("exports.dead = 1; delete exports.dead; exports.live = 2;").outcomes[0].value,
      { kind: 'object', properties: ['live'] });
    assert.deepStrictEqual(analysis("function unused(module) { module.exports = require('./dead'); }")
      .outcomes[0].value, { kind: 'object', properties: [] });
    assert.deepStrictEqual(analysis("return; module.exports = require('./dead');").outcomes[0].value,
      { kind: 'object', properties: [] });
  });

  test('compound right-hand sides and comma expressions use their final value', () => {
    assert.deepStrictEqual(analysis("module.exports = (require('./a'), {});").outcomes[0].value,
      { kind: 'object', properties: [] });
    const result = analysis("module.exports = require('./a') && {};");
    assert.deepStrictEqual(result.outcomes.map(
      /** @param {FlowOutcome} outcome */ outcome => outcome.value.kind
    ), ['object', 'module']);
  });

  test('unknown spread shapes are explicit rather than confirmed module reexports', () => {
    const result = analysis("module.exports = {...require('./a'), ...require('./b')};");
    assert.equal(result.complete, false);
    assert.equal(result.outcomes[0].value.kind, 'unknown');
    assert.equal(result.outcomes[0].value.reason, 'unresolved-spread');
  });

  test('dependency execution invalidates exposed export state', () => {
    for (const source of ["exports.before = 1; require('./mutate');", "exports.dep = require('./a');",
      "const target = {}; require('./mutate'); target.after = 1; module.exports = target;"]) {
      const result = analysis(source);
      assert.equal(result.complete, false);
      assert.equal(result.outcomes[0].value.kind, 'unknown');
      assert.equal(result.outcomes[0].value.reason, 'dependency-effects');
    }
    const local = analysis("const target = {safe: 1}; require('./mutate'); module.exports = target;");
    assert.deepStrictEqual(local.outcomes[0].value, { kind: 'object', properties: ['safe'] });
    const captured = analysis("const target = {dead: 1}; function mutate() { delete target.dead; } " +
      "exports.mutate = mutate; require('./call'); module.exports = target;");
    assert.equal(captured.complete, false);
    assert.equal(captured.outcomes[0].value.kind, 'unknown');
  });

  test('opaque condition reads can have effects and are not correlated', () => {
    const result = analysis("if (flag) { if (!flag) module.exports = require('./a'); }");
    assert.equal(result.complete, false);
    assert.equal(result.outcomes.some(
      /** @param {FlowOutcome} outcome */ outcome => outcome.value.kind === 'module'
    ), true);
    const unchanged = analysis('if (globalThis.flag) {}');
    assert.equal(unchanged.complete, false);
    assert.equal(unchanged.outcomes[0].value.kind, 'unknown');
  });

  test('opaque getter effects match a real CommonJS load without executing analysis input', () => {
    const source = "if (flowPocCondition) module.exports = require('./a');";
    const { report, observed } = observeFlowSource(source,
      /** @param {() => Record<string, unknown>} getExports */
      getExports => { getExports().real = 1; return false; }
    );
    assert.equal(report.complete, false);
    assert.equal(report.outcomes[1].value.kind, 'unknown');
    assert.deepStrictEqual(observed, { real: 1 });
  });

  test('invalidated objects cannot provide cached values or references', () => {
    const prefix = 'const target = exports; target.enabled = false; flowPocCondition; ';
    const cases = [
      [prefix + 'module.exports = target.enabled ? {live: 1} : {dead: 1};',
        /** @param {() => Record<string, unknown>} getExports */
        getExports => { getExports().enabled = true; return false; }],
      [prefix + 'module.exports = (delete target.enabled) ? {dead: 1} : {live: 1};',
        /** @param {() => Record<string, unknown>} getExports */
        getExports => { Object.defineProperty(getExports(), 'enabled', { configurable: false }); return false; }],
      [prefix + 'module.exports = {}; target.enabled = 1;',
        /** @param {() => Record<string, unknown>} getExports */
        getExports => {
          Object.defineProperty(getExports(), 'enabled', {
            configurable: true,
            /** @param {number} value */
            set (value) { getExports().live = value; }
          });
          return false;
        }]
    ];
    for (const [source, effect] of cases) {
      const { report, observed } = observeFlowSource(source, effect);
      assert.equal(report.complete, false, source);
      assert.equal(report.outcomes[0].value.kind, 'unknown', source);
      assert.deepStrictEqual(observed, { live: 1 }, source);
    }
  });

  test('numeric object keys use runtime property names', () => {
    const source = 'module.exports = {0x10: 1, 1e2: 1, 1.0: 1, 0b10: 1, 0o7: 1};';
    assert.deepStrictEqual(analysis(source).outcomes[0].value.properties, ['16', '100', '1', '2', '7']);
  });

  test('inherited accessors cannot leave confirmed exports after opaque effects', () => {
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'flowPocProperty');
    try {
      for (const operator of ['=', '&&=', '||=', '??=']) {
        const source = 'const target = {}; flowPocCondition; module.exports = {live: 1}; ' +
          'target.flowPocProperty ' + operator + ' 1;';
        const { report, observed } = observeFlowSource(source,
          /** @param {() => Record<string, unknown>} getExports */
          getExports => {
            Object.defineProperty(Object.prototype, 'flowPocProperty', {
              configurable: true,
              get () { delete getExports().live; },
              /** @param {number} value */
              set (value) { delete getExports().live; }
            });
            return false;
          }
        );
        assert.equal(report.complete, false, operator);
        assert.equal(report.outcomes[0].value.kind, 'unknown', operator);
        assert.deepStrictEqual(observed, {}, operator);
      }
    } finally {
      if (previous) Object.defineProperty(Object.prototype, 'flowPocProperty', previous);
      else delete Object.prototype.flowPocProperty;
    }
  });

  test('shallow source cannot build an unbounded expression tree', () => {
    const accepted = 'module.exports = ' + Array(62).fill('1').join('+') + ';';
    assert.deepStrictEqual(analysis(accepted).outcomes[0].value, { kind: 'literal', value: 62 });
    for (const source of ['module.exports = ' + Array(63).fill('1').join('+') + ';',
      'module.exports = ' + Array(1000).fill('1').join('+') + ';',
      'module.exports = exports' + '.a'.repeat(1000) + ';',
      "module.exports = require('./a')" + '()'.repeat(1000) + ';']) {
      const report = analysis(source);
      assert.equal(report.complete, false);
      assert.equal(report.outcomes[0].value.reason, 'depth-limit');
    }
  });

  test('implicit coercion and opaque spread can change exports', () => {
    const prefix = 'const operand = flowPocCondition; module.exports = {}; ';
    for (const suffix of ['+operand;', '-operand;', 'operand + 1;', 'operand - 1;', 'operand * 1;',
      'operand % 2;', 'operand == 1;', 'operand != 1;', 'operand < 1;', 'operand > 1;',
      'operand <= 1;', 'operand >= 1;', '({...operand});', 'const copy = {...operand}; ({...copy});']) {
      const { report, observed } = observeFlowSource(prefix + suffix,
        /** @param {() => Record<string, unknown>} getExports */
        getExports => ({
          valueOf () { getExports().live = 1; return 1; },
          get spread () { getExports().live = 1; return 1; }
        })
      );
      assert.equal(report.complete, false, suffix);
      assert.equal(report.outcomes[0].value.kind, 'unknown', suffix);
      assert.deepStrictEqual(observed, { live: 1 }, suffix);
    }
    for (const suffix of ['operand === 1;', 'operand !== 1;', 'typeof operand;', '!operand;', 'void operand;']) {
      const { report, observed } = observeFlowSource(prefix + suffix,
        /** @param {() => Record<string, unknown>} getExports */
        getExports => ({ valueOf () { getExports().live = 1; return 1; } })
      );
      assert.equal(report.complete, true, suffix);
      assert.deepStrictEqual(report.outcomes[0].value, { kind: 'object', properties: [] }, suffix);
      assert.deepStrictEqual(observed, {}, suffix);
    }
  });

  test('unsupported effects never produce speculative exports', () => {
    for (const source of ["mutate(exports);", "while (flag) module.exports = require('./a');",
      "try { module.exports = require('./a'); } catch (error) { module.exports = require('./b'); }",
      "module.exports[key] = 1;", "const require = other; module.exports = require('./a');"]) {
      const result = analysis(source);
      assert.equal(result.complete, false);
      assert.equal(result.outcomes[0].value.kind, 'unknown');
      assert.equal(JSON.stringify(result.outcomes).includes('specifier'), false);
    }
  });

  test('source text is never executed', () => {
    globalThis.flowPocExecuted = false;
    const result = analysis('globalThis.flowPocExecuted = true;');
    assert.equal(globalThis.flowPocExecuted, false);
    assert.equal(result.complete, false);
    delete globalThis.flowPocExecuted;
  });

  test('captures an assignment target before evaluating its right-hand side', () => {
    assert.deepStrictEqual(analysis('let target = {}; target.foo = (target = exports, 1);').outcomes[0].value,
      { kind: 'object', properties: [] });
    assert.deepStrictEqual(analysis('let target = exports; target.foo = (target = {}, 1);').outcomes[0].value,
      { kind: 'object', properties: ['foo'] });
    for (const [initial, operator] of [['0', '||='], ['true', '&&='], ['null', '??=']]) {
      assert.deepStrictEqual(analysis('let target = {foo: ' + initial + '}; target.foo ' + operator +
        ' (target = exports, 1);').outcomes[0].value, { kind: 'object', properties: [] });
    }
  });

  test('rejects unsupported binding changes and ambiguous number forms', () => {
    for (const source of ['const flag = false; flag = true;', 'missing = 1;',
      "if (010 === 8) module.exports = require('./a');"]) {
      const result = analysis(source);
      assert.equal(result.complete, false);
      assert.equal(result.outcomes[0].value.kind, 'unknown');
    }
  });

  test('hoists var declarations without resetting wrapper parameters', () => {
    assert.deepStrictEqual(analysis("var module; module.exports = require('./a');").outcomes[0].value,
      { kind: 'module', specifier: './a' });
    assert.deepStrictEqual(analysis("if (flag) module.exports = require('./dead'); if (false) { var flag; }")
      .outcomes[0].value, { kind: 'object', properties: [] });
  });

  test('bounds branch expansion and nesting', () => {
    assert.equal(analysis('('.repeat(62) + 'true' + ')'.repeat(62) + ';').complete, true);
    const accepted = Array.from({ length: 5 },
      /** @param {undefined} entry @param {number} index */
      (entry, index) => 'if (flag' + index + ') module.exports = {a: 1}; else module.exports = {};'
    ).join('\n');
    assert.equal(analysis(accepted).outcomes.length, 32);
    assert.equal(analysis(';'.repeat(8192)).complete, true);
    for (const source of ['('.repeat(63) + 'true' + ')'.repeat(63) + ';', ';'.repeat(8193),
      accepted + '\nif (flag5) module.exports = {a: 1}; else module.exports = {};']) {
      const result = analysis(source);
      assert.equal(result.complete, false);
      assert.equal(result.outcomes[0].value.kind, 'unknown');
      assert.match(result.outcomes[0].value.reason, /limit/);
    }
  });

  test('confirmed outcomes match exports from real CommonJS modules', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cjs-flow-'));
    writeFileSync(join(directory, 'a.cjs'), 'module.exports = {a: 1};');
    writeFileSync(join(directory, 'b.cjs'), 'module.exports = {b: 1};');
    const sources = [
      "if (true) module.exports = require('./a.cjs'); else module.exports = require('./b.cjs');",
      "if (false) module.exports = require('./a.cjs'); else module.exports = require('./b.cjs');",
      "module.exports = require('./a.cjs'); module.exports = require('./b.cjs');",
      'module.exports = {live: 1}; exports.dead = 1;',
      "module.exports = {dep: require('./a.cjs')};",
      'let target = {}; target.foo = (target = exports, 1);',
      'let target = exports; target.foo = (target = {}, 1);',
      'let target = {foo: 0}; target.foo ||= (target = exports, 1);',
      'module.exports = {0x10: 1, 1e2: 1, 1.0: 1, 0b10: 1, 0o7: 1};',
      "module.exports = (module = {}, require('./a.cjs'));",
      'const a = {x: 1}; const b = {x: 2, y: 3}; module.exports = {...a, ...b};',
      'exports.dead = 1; delete exports.dead; exports.live = 2;',
      'function unused(module) { module.exports = 1; }',
      'return; module.exports = 1;',
      'module.exports = exports = {}; exports.live = 1;'
    ];
    try {
      for (let index = 0; index < sources.length; index++) {
        const source = sources[index];
        const filename = join(directory, 'entry-' + index + '.cjs');
        writeFileSync(filename, source);
        const requireFixture = createRequire(filename);
        const observed = requireFixture(filename);
        const report = analysis(source);
        assert.equal(report.complete, true, source);
        assert.equal(report.outcomes.length, 1, source);
        const value = report.outcomes[0].value;
        if (value.kind === 'module') assert.equal(observed, requireFixture(value.specifier), source);
        else assert.deepStrictEqual(Object.keys(observed).sort(), value.properties.slice().sort(), source);
        delete requireFixture.cache[requireFixture.resolve(filename)];
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
