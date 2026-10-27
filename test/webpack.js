const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

let parse;
const options = { mode: 'extended' };

/** @param {string} modules */
function bundle (modules) {
  return `(() => {
    const __webpack_modules__ = { ${modules} };
    const cache = {};
    function __webpack_require__(id) {
      if (cache[id]) return cache[id].exports;
      const module = cache[id] = { exports: {} };
      __webpack_modules__[id](module, module.exports, __webpack_require__);
      return module.exports;
    }
    const __webpack_exports__ = __webpack_require__('entry');
    module.exports = __webpack_exports__;
  })();`;
}

/** @param {string} id */
function star (id) {
  return `var dep = __webpack_require__(${JSON.stringify(id)});
    Object.keys(dep).forEach(function (key) {
      if (key === 'default' || key === '__esModule') return;
      exports[key] = dep[key];
    });`;
}

suite('Webpack extended detection', () => {
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

  test('published jest-watcher@30.2.0 bundle excludes internal default exports', () => {
    const source = readFileSync(join(__dirname, 'fixtures/webpack/jest-watcher.cjs'), 'utf8');
    const result = parse(source, 'jest-watcher.cjs', options);
    assert.ok(!result.exports.includes('default'));
    assert.deepEqual(result.exports.sort(), [
      'BaseWatchPlugin', 'JestHook', 'KEYS', 'PatternPrompt', 'Prompt', 'TestWatcher',
      '__esModule', 'printPatternCaret', 'printRestoredPatternCaret'
    ].sort());
    assert.deepEqual(result.reexports, []);
    assert.deepEqual(parse(source).exports, [
      'default', 'KEYS', 'printPatternCaret', 'printRestoredPatternCaret'
    ]);
  });

  test('entry exports exclude unrelated factories', () => {
    const source = bundle(`
      unused: (module, exports) => { exports.hidden = 1; },
      entry: (module, exports) => { exports.visible = 2; }
    `);
    const module = { exports: {} };
    vm.runInNewContext(source, { module });
    const result = parse(source, 'bundle.cjs', options);
    assert.ok(!result.exports.includes('hidden'));
    assert.deepEqual(result.exports, Object.keys(module.exports));
    assert.deepEqual(result.reexports, []);
  });

  const factories = [
    'entry: (module, exports) => { exports.visible = 1; }',
    'entry: function(module, exports) { exports.visible = 1; }',
    'entry: (m, e) => { e.visible = 1; }',
    'entry: (m) => { m.exports = { visible: 1 }; }',
    'entry: () => {}'
  ];
  for (const factory of factories) {
    test(`factory ${factory}`, () => {
      const source = bundle(`unused: (m, e) => { e.hidden = 1; }, ${factory}`);
      const module = { exports: {} };
      vm.runInNewContext(source, { module });
      assert.deepEqual(parse(source, 'bundle.cjs', options).exports, Object.keys(module.exports));
    });
  }

  test('Webpack getter maps use the factory export binding', () => {
    const source = bundle(`
      unused: (m, __webpack_exports__) => {
        __webpack_require__.d(__webpack_exports__, { hidden: () => 0 });
      },
      entry: (m, __webpack_exports__) => {
        __webpack_require__.d(__webpack_exports__, { visible: () => 1, ['quoted']: () => 2 });
      }
    `);
    assert.deepEqual(parse(source, 'bundle.cjs', options), { exports: ['visible', 'quoted'], reexports: [] });
  });

  test('descriptors can target the module parameter', () => {
    const source = bundle(`entry: (m, e) => {
      Object.defineProperties(m.exports, { visible: { value: 1 } });
    }`);
    assert.deepEqual(parse(source, 'bundle.cjs', options), { exports: ['visible'], reexports: [] });
  });

  test('inlined entries exclude unrelated factories', () => {
    const source = bundle(`entry: (m, exports) => { exports.hidden = 1; }`)
      .replace("const __webpack_exports__ = __webpack_require__('entry');",
        'const __webpack_exports__ = {}; __webpack_exports__.visible = 1;');
    const module = { exports: {} };
    vm.runInNewContext(source, { module });
    assert.deepEqual(parse(source, 'bundle.cjs', options).exports, Object.keys(module.exports));
  });

  test('inlined entry star reexports follow internal dependencies', () => {
    const source = bundle(`
      unused: (m, exports) => { exports.hidden = 1; },
      dependency: (m, exports) => {
        exports.default = 1; exports.__esModule = true; exports.visible = 2;
      }
    `).replace("const __webpack_exports__ = __webpack_require__('entry');", `
      const __webpack_exports__ = {};
      (() => { var exports = __webpack_exports__; ${star('dependency')} })();`);
    const module = { exports: {} };
    vm.runInNewContext(source, { module });
    assert.deepEqual(parse(source, 'bundle.cjs', options).exports, Object.keys(module.exports));
  });

  test('unknown inlined entry star reexports retain candidates', () => {
    const source = bundle(`
      unused: (m, exports) => { exports.hidden = 1; },
      dependency: (m, exports) => { exports.visible = 1; }
    `).replace("const __webpack_exports__ = __webpack_require__('entry');", `
      const __webpack_exports__ = {};
      (() => { var exports = __webpack_exports__; ${star('unknown')} })();`);
    assert.deepEqual(parse(source, 'bundle.cjs', options).exports.sort(), ['hidden', 'visible']);
  });

  test('inlined entries ignore non-reexported internal dependencies', () => {
    const source = bundle('dependency: (m, exports) => { exports.hidden = 1; }')
      .replace("const __webpack_exports__ = __webpack_require__('entry');", `
        const __webpack_exports__ = {};
        __webpack_require__('dependency');
        __webpack_exports__.visible = 1;`);
    const module = { exports: {} };
    vm.runInNewContext(source, { module });
    assert.deepEqual(parse(source, 'bundle.cjs', options).exports, Object.keys(module.exports));
  });

  test('internal whole-module reexports retain default', () => {
    const source = bundle(`
      dependency: (m, e) => { e.default = 1; e.visible = 2; },
      entry: (m, e) => { m.exports = __webpack_require__('dependency'); }
    `);
    assert.deepEqual(parse(source, 'bundle.cjs', options), { exports: ['default', 'visible'], reexports: [] });
  });

  test('internal star reexports exclude default and __esModule', () => {
    const source = bundle(`
      unused: (m, exports) => { exports.hidden = 1; },
      dependency: (m, exports) => {
        exports.default = 1; exports.__esModule = true; exports.visible = 2;
      },
      entry: (m, exports) => { exports.own = 1; ${star('dependency')} }
    `);
    const module = { exports: {} };
    vm.runInNewContext(source, { module });
    assert.deepEqual(parse(source, 'bundle.cjs', options).exports, Object.keys(module.exports));
  });

  test('star reexports terminate on cycles', () => {
    const source = bundle(`
      dependency: (m, exports) => { exports.second = 2; ${star('entry')} },
      entry: (m, exports) => { exports.first = 1; ${star('dependency')} }
    `);
    const module = { exports: {} };
    vm.runInNewContext(source, { module });
    assert.deepEqual(parse(source, 'bundle.cjs', options).exports, Object.keys(module.exports));
  });

  test('whole-module reexports upgrade a prior star visit', () => {
    const source = bundle(`
      leaf: (m, exports) => { exports.default = 1; exports.visible = 2; },
      middle: (module, exports) => { module.exports = __webpack_require__('leaf'); },
      entry: (module, exports) => { ${star('leaf')} module.exports = __webpack_require__('middle'); }
    `);
    assert.deepEqual(parse(source, 'bundle.cjs', options).exports.sort(), ['default', 'visible']);
  });

  test('external reexports belong to the selected entry', () => {
    const source = bundle(`
      unused: (module) => { module.exports = require('hidden'); },
      entry: (module) => { module.exports = require('visible'); }
    `);
    assert.deepEqual(parse(source, 'bundle.cjs', options), { exports: [], reexports: ['visible'] });
  });

  test('numeric module identifiers', () => {
    const source = bundle(`
      0: (m, e) => { e.hidden = 1; },
      1: (m, e) => { e.visible = 1; }
    `).replace("__webpack_require__('entry')", '__webpack_require__(1)');
    assert.deepEqual(parse(source, 'bundle.cjs', options), { exports: ['visible'], reexports: [] });
  });

  test('quoted and escaped module identifiers', () => {
    const source = bundle(`
      unused: (m, e) => { e.hidden = 1; },
      'entr\\u0079': (m, e) => { e.visible = 1; }
    `);
    assert.deepEqual(parse(source, 'bundle.cjs', options), { exports: ['visible'], reexports: [] });
  });

  for (const id of ['', '__proto__', '\u{1f4a9}', 'a"b', 'a\\b']) {
    test(`module identifier ${JSON.stringify(id)}`, () => {
      const source = bundle(`
        unused: (m, exports) => { exports.hidden = 1; },
        ${JSON.stringify(id)}: (m, exports) => { exports.visible = 1; }
      `).replace("__webpack_require__('entry')", `__webpack_require__(${JSON.stringify(id)})`);
      assert.deepEqual(parse(source, 'bundle.cjs', options), { exports: ['visible'], reexports: [] });
    });
  }

  test('module maps grow without losing factories', () => {
    const factories = [];
    for (let i = 0; i < 200; i++) factories.push(`${i}: (m, exports) => { exports.hidden = 1; }`);
    factories.push('entry: (m, exports) => { exports.visible = 1; }');
    assert.deepEqual(parse(bundle(factories.join(',')), 'bundle.cjs', options),
      { exports: ['visible'], reexports: [] });
  });

  test('direct startup reexport', () => {
    const source = bundle(`
      unused: (m, e) => { e.hidden = 1; },
      entry: (m, e) => { e.visible = 1; }
    `).replace("const __webpack_exports__ = __webpack_require__('entry');\n    module.exports = __webpack_exports__;",
      "module.exports = __webpack_require__('entry');");
    assert.deepEqual(parse(source, 'bundle.cjs', options), { exports: ['visible'], reexports: [] });
  });

  test('unknown entries retain candidate detection', () => {
    const source = bundle('entry: (m, exports) => { exports.visible = 1; }')
      .replace("__webpack_require__('entry');\n    module.exports", "__webpack_require__('unknown');\n    module.exports");
    assert.deepEqual(parse(source, 'bundle.cjs', options), { exports: ['visible'], reexports: [] });
  });

  for (const suffix of ['.nested', ' + other', '[key]']) {
    test(`modified startup expression ${suffix} retains candidates`, () => {
      const source = bundle(`unused: (m, exports) => { exports.hidden = 1; },
        entry: (m, exports) => { exports.visible = 1; }`)
        .replace("__webpack_require__('entry');", `__webpack_require__('entry')${suffix};`);
      assert.deepEqual(parse(source, 'bundle.cjs', options).exports.sort(), ['hidden', 'visible']);
    });
    test(`modified published value ${suffix} retains candidates`, () => {
      const source = bundle(`unused: (m, exports) => { exports.hidden = 1; },
        entry: (m, exports) => { exports.visible = 1; }`)
        .replace('module.exports = __webpack_exports__;', `module.exports = __webpack_exports__${suffix};`);
      assert.deepEqual(parse(source, 'bundle.cjs', options).exports.sort(), ['hidden', 'visible']);
    });
  }

  test('unknown internal reexports retain candidate detection', () => {
    const source = bundle(`
      unused: (m, exports) => { exports.hidden = 1; },
      entry: (module, exports) => { exports.visible = 1; module.exports = __webpack_require__('unknown'); }
    `);
    assert.deepEqual(parse(source, 'bundle.cjs', options).exports.sort(), ['hidden', 'visible']);
  });

  test('unpublished tables retain candidate detection', () => {
    const source = bundle('entry: (m, exports) => { exports.visible = 1; }')
      .replace('module.exports = __webpack_exports__;', '');
    assert.deepEqual(parse(source, 'bundle.cjs', options), { exports: ['visible'], reexports: [] });
  });

  test('duplicate module identifiers retain candidate detection', () => {
    const source = bundle(`entry: (m, exports) => { exports.first = 1; },
      entry: (m, exports) => { exports.second = 2; }`);
    assert.deepEqual(parse(source, 'bundle.cjs', options).exports.sort(), ['first', 'second']);
  });

  test('comments, strings, and templates cannot create a module table', () => {
    const source = `
      // __webpack_modules__ = { entry: (m, exports) => { exports.fake = 1; } };
      const text = '__webpack_modules__ = {';
      const template = \`__webpack_modules__ = {\`;
      exports.visible = 1;
    `;
    assert.deepEqual(parse(source, 'bundle.cjs', options), { exports: ['visible'], reexports: [] });
  });

  test('bundle detection resets after a scanner error', () => {
    const source = 'var __webpack_modules__ = { entry: (m, e) => { e.hidden = 1;';
    assert.throws(() => parse(source, 'broken.cjs', options), /broken.cjs/);
    assert.deepEqual(parse('exports.visible = 1;'), { exports: ['visible'], reexports: [] });
    assert.deepEqual(parse(bundle('entry: (m, e) => { e.visible = 1; }'), 'bundle.cjs', options),
      { exports: ['visible'], reexports: [] });
  });
});
