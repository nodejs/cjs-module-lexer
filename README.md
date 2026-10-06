# CJS Module Lexer

[![Build Status][travis-image]][travis-url]

A [very fast](#benchmarks) JS CommonJS module syntax lexer used to detect the most likely list of named exports of a CommonJS module.

Outputs the list of named exports (`exports.name = ...`) and possible module reexports (`module.exports = require('...')`), including the common transpiler variations of these cases.

Forked from https://github.com/guybedford/es-module-lexer.

_Comprehensively handles the JS language grammar while remaining small and fast. - ~90ms per MB of JS cold and ~15ms per MB of JS warm, [see benchmarks](#benchmarks) for more info._

### Project Status

This project is used in Node.js core for detecting the named exports available when importing a CJS module into ESM, and is maintained for this purpose.

PRs will be accepted and upstreamed for parser bugs, performance improvements or new syntax support only.

_Detection patterns for the `legacy` baseline are **frozen**_. This is because adding any new export detection patterns would result in fragmented backwards-compatibility. Specifically, it would be very difficult to figure out why an ES module named export for CommonJS might work in newer Node.js versions but not older versions. This problem would only be discovered downstream of module authors, with the fix for module authors being to then have to understand which patterns in this project provide full backwards-compatibily. Rather, by fully freezing the detected patterns, if it works in any Node.js version it will work in any other. Build tools can also reliably treat the supported syntax for this project as a part of their output target for ensuring syntax support.

### Usage

```
npm install cjs-module-lexer
```

For use in CommonJS:

```js
const { parse } = require('cjs-module-lexer');

// Parsing initializes Wasm on demand. Await init() to initialize it in advance.

const { exports, reexports, complete } = parse(`
  if (mode) module.exports = { own: 1, ...require('./dep1.js') };
  else module.exports = { own: 2, ...require('./dep2.js') };
`);

// exports: ['own']
// reexports: [['./dep1.js'], ['./dep2.js']]
// complete: true
```

When using the ESM version, Wasm is supported instead:

```js
import { parse, init } from 'cjs-module-lexer';
// In browsers, initialize the Wasm before parsing.
await init();
const { exports, reexports } = parse(source);
```

`parse` calls `initSync()` on first use if initialization has not completed.
Call `initSync()` directly to choose when the blocking initialization runs.
Browser main threads can restrict synchronous Wasm compilation, so await
`init()` before parsing in browsers.

### Detection baselines (proof of concept)

The default `reexports` value stays flat for one distinct final dependency list.
Different conditional lists produce an array of arrays.
Each inner array contains dependencies combined in one final export value.
The outer array contains alternative final values.
Identical lists are deduplicated before choosing the return shape.
Conditional nesting changes the return type and requires a major release.

```js
const { reexports, complete } = parse(`
  if (production) module.exports = {...require('./a.cjs'), ...require('./b.cjs')};
  else module.exports = {...require('./c.cjs'), ...require('./d.cjs')};
`);
// reexports: [['./a.cjs', './b.cjs'], ['./c.cjs', './d.cjs']]
// complete: true
```

Sequential replacements retain only the final value.
Pure guards remove unreachable branches. Unknown guards retain their possible alternatives.
Object spreads of direct `require` calls combine dependencies in one group.
The `exports` array contains detected literal names from surviving values.

Flow analysis runs only after the lexer detects more than one `module.exports` replacement.
The counter ignores comments, strings, property writes, and comparisons.
With fewer replacements, existing detection patterns run and their reexports stay flat.
The optional third argument selects a versioned detection baseline.
Select `legacy` for frozen detection, or `flow-v1` for the default conditional analysis.
A baseline can combine detection rules without an option for each rule.

The C lexer compiled to Wasm owns flow analysis.
The JavaScript entry point invokes it only for competing replacements.
Use valid CommonJS source with standard CommonJS bindings and an ordinary writable `module.exports` property.
Analysis describes successful synchronous completion and does not execute source or resolve dependencies.
Opaque reads and dependency execution invalidate earlier exposed values. A fresh replacement can establish a known value again.

Results include `complete` only when flow analysis runs.
Unsupported syntax, effects, bindings, filtered string literals, and analysis limits make it false.
An incomplete result contains confirmed alternatives and omits unknown values.
Token, nesting, outcome, and work limits bound the analyzer.
Existing lexer errors still apply.

### Grammar

The grammar below describes the `legacy` baseline.

CommonJS exports matches are run against the source token stream.

The token grammar is:

```
IDENTIFIER: As defined by ECMA-262, without support for identifier `\` escapes, filtered to remove strict reserved words:
            "implements", "interface", "let", "package", "private", "protected", "public", "static", "yield", "enum"

STRING_LITERAL: A `"` or `'` bounded ECMA-262 string literal.

MODULE_EXPORTS: `module` `.` `exports`

EXPORTS_IDENTIFIER: MODULE_EXPORTS_IDENTIFIER | `exports`

EXPORTS_DOT_ASSIGN: EXPORTS_IDENTIFIER `.` IDENTIFIER `=`

EXPORTS_LITERAL_COMPUTED_ASSIGN: EXPORTS_IDENTIFIER `[` STRING_LITERAL `]` `=`

EXPORTS_LITERAL_PROP: (IDENTIFIER  (`:` IDENTIFIER)?) | (STRING_LITERAL `:` IDENTIFIER)

EXPORTS_SPREAD: `...` (IDENTIFIER | REQUIRE)

EXPORTS_MEMBER: EXPORTS_DOT_ASSIGN | EXPORTS_LITERAL_COMPUTED_ASSIGN

EXPORTS_DEFINE: `Object` `.` `defineProperty `(` EXPORTS_IDENFITIER `,` STRING_LITERAL

EXPORTS_DEFINE_VALUE: EXPORTS_DEFINE `, {`
  (`enumerable: true,`)?
  (
    `value:` |
    `get` (`: function` IDENTIFIER? )?  `() {` return IDENTIFIER (`.` IDENTIFIER | `[` STRING_LITERAL `]`)? `;`? `}` `,`?
  )
  `})`

EXPORTS_LITERAL: MODULE_EXPORTS `=` `{` (EXPORTS_LITERAL_PROP | EXPORTS_SPREAD) `,`)+ `}`

REQUIRE: `require` `(` STRING_LITERAL `)`

EXPORTS_ASSIGN: (`var` | `const` | `let`) IDENTIFIER `=` (`_interopRequireWildcard (`)? REQUIRE

MODULE_EXPORTS_ASSIGN: MODULE_EXPORTS `=` REQUIRE

EXPORT_STAR: (`__export` | `__exportStar`) `(` REQUIRE

EXPORT_STAR_LIB: `Object.keys(` IDENTIFIER$1 `).forEach(function (` IDENTIFIER$2 `) {`
  (
    (
      `if (` IDENTIFIER$2 `===` ( `'default'` | `"default"` ) `||` IDENTIFIER$2 `===` ( '__esModule' | `"__esModule"` ) `) return` `;`?
      (
        (`if (Object` `.prototype`? `.hasOwnProperty.call(`  IDENTIFIER `, ` IDENTIFIER$2 `)) return` `;`?)?
        (`if (` IDENTIFIER$2 `in` EXPORTS_IDENTIFIER `&&` EXPORTS_IDENTIFIER `[` IDENTIFIER$2 `] ===` IDENTIFIER$1 `[` IDENTIFIER$2 `]) return` `;`)?
      )?
    ) |
    `if (` IDENTIFIER$2 `!==` ( `'default'` | `"default"` ) (`&& !` (`Object` `.prototype`? `.hasOwnProperty.call(`  IDENTIFIER `, ` IDENTIFIER$2 `)` | IDENTIFIER `.hasOwnProperty(` IDENTIFIER$2 `)`))? `)`
  )
  (
    EXPORTS_IDENTIFIER `[` IDENTIFIER$2 `] =` IDENTIFIER$1 `[` IDENTIFIER$2 `]` `;`? |
    `Object.defineProperty(` EXPORTS_IDENTIFIER `, ` IDENTIFIER$2 `, { enumerable: true, get` (`: function` IDENTIFIER? )?  `() { return ` IDENTIFIER$1 `[` IDENTIFIER$2 `]` `;`? `}` `,`? `})` `;`?
  )
  `})`
```

Spacing between tokens is taken to be any ECMA-262 whitespace, ECMA-262 block comment or ECMA-262 line comment.

* The returned export names are taken to be the combination of:
  1. All `IDENTIFIER` and `STRING_LITERAL` slots for `EXPORTS_MEMBER` and `EXPORTS_LITERAL` matches.
  2. The first `STRING_LITERAL` slot for all `EXPORTS_DEFINE_VALUE` matches where that same string is not an `EXPORTS_DEFINE` match that is not also an `EXPORTS_DEFINE_VALUE` match.
* The reexport specifiers are taken to be the combination of:
  1. The `REQUIRE` matches of the last matched of either `MODULE_EXPORTS_ASSIGN` or `EXPORTS_LITERAL`.
  2. All _top-level_ `EXPORT_STAR` `REQUIRE` matches and `EXPORTS_ASSIGN` matches whose `IDENTIFIER` also matches the first `IDENTIFIER` in `EXPORT_STAR_LIB`.

### Parsing Examples

#### Named Exports Parsing

The basic matching rules for named exports are `exports.name`, `exports['name']` or `Object.defineProperty(exports, 'name', ...)`. This matching is done without scope analysis and regardless of the expression position:

```js
// DETECTS EXPORTS: a, b
(function (exports) {
  exports.a = 'a'; 
  exports['b'] = 'b';
})(exports);
```

Because there is no scope analysis, the above detection may overclassify:

```js
// DETECTS EXPORTS: a, b, c
(function (exports, Object) {
  exports.a = 'a';
  exports['b'] = 'b';
  if (false)
    exports.c = 'c';
})(NOT_EXPORTS, NOT_OBJECT);
```

It will in turn underclassify in cases where the identifiers are renamed:

```js
// DETECTS: NO EXPORTS
(function (e) {
  e.a = 'a';
  e['b'] = 'b';
})(exports);
```

#### Getter Exports Parsing

`Object.defineProperty` is detected for specifically value and getter forms returning an identifier or member expression:

```js
// DETECTS: a, b, c, d, __esModule
Object.defineProperty(exports, 'a', {
  enumerable: true,
  get: function () {
    return q.p;
  }
});
Object.defineProperty(exports, 'b', {
  enumerable: true,
  get: function () {
    return q['p'];
  }
});
Object.defineProperty(exports, 'c', {
  enumerable: true,
  get () {
    return b;
  }
});
Object.defineProperty(exports, 'd', { value: 'd' });
Object.defineProperty(exports, '__esModule', { value: true });
```

Value properties are also detected specifically:

```js
Object.defineProperty(exports, 'a', {
  value: 'no problem'
});
```

To avoid matching getters that have side effects, any getter for an export name that does not support the forms above will
opt-out of the getter matching:

```js
// DETECTS: NO EXPORTS
Object.defineProperty(exports, 'a', {
  get () {
    return 'nope';
  }
});

if (false) {
  Object.defineProperty(module.exports, 'a', {
    get () {
      return dynamic();
    }
  })
}
```

Alternative object definition structures or getter function bodies are not detected:

```js
// DETECTS: NO EXPORTS
Object.defineProperty(exports, 'a', {
  enumerable: false,
  get () {
    return p;
  }
});
Object.defineProperty(exports, 'b', {
  configurable: true,
  get () {
    return p;
  }
});
Object.defineProperty(exports, 'c', {
  get: () => p
});
Object.defineProperty(exports, 'd', {
  enumerable: true,
  get: function () {
    return dynamic();
  }
});
Object.defineProperty(exports, 'e', {
  enumerable: true,
  get () {
    return 'str';
  }
});
```

`Object.defineProperties` is also not supported.

#### Exports Object Assignment

A best-effort is made to detect `module.exports` object assignments, but because this is not a full parser, arbitrary expressions are not handled in the
object parsing process.

Simple object definitions are supported:

```js
// DETECTS EXPORTS: a, b, c
module.exports = {
  a,
  'b': b,
  c: c,
  ...d
};
```

Object properties that are not identifiers or string expressions will bail out of the object detection, while spreads are ignored:

```js
// DETECTS EXPORTS: a, b
module.exports = {
  a,
  ...d,
  b: require('c'),
  c: "not detected since require('c') above bails the object detection"
}
```

`Object.defineProperties` is not currently supported either.

#### module.exports reexport assignment

Any `module.exports = require('mod')` assignment is detected as a reexport, but only the last one is returned:

```js
// DETECTS REEXPORTS: c
module.exports = require('a');
(module => module.exports = require('b'))(NOT_MODULE);
if (false) module.exports = require('c');
```

This is to avoid over-classification in Webpack bundles with externals which include `module.exports = require('external')` in their source for every external dependency.

In exports object assignment, any spread of `require()` are detected as multiple separate reexports:

```js
// DETECTS REEXPORTS: a, b
module.exports = require('ignored');
module.exports = {
  ...require('a'),
  ...require('b')
};
```

#### Transpiler Re-exports

For named exports, transpiler output works well with the rules described above.

But for star re-exports, special care is taken to support common patterns of transpiler outputs from Babel and TypeScript as well as bundlers like RollupJS.
These reexport and star reexport patterns are restricted to only be detected at the top-level as provided by the direct output of these tools.

For example, `export * from 'external'` is output by Babel as:

```js
"use strict";

exports.__esModule = true;

var _external = require("external");

Object.keys(_external).forEach(function (key) {
  if (key === "default" || key === "__esModule") return;
  exports[key] = _external[key];
});
```

Where the `var _external = require("external")` is specifically detected as well as the `Object.keys(_external)` statement, down to the exact
for of that entire expression including minor variations of the output. The `_external` and `key` identifiers are carefully matched in this
detection.

Similarly for TypeScript, `export * from 'external'` is output as:

```js
"use strict";
function __export(m) {
    for (var p in m) if (!exports.hasOwnProperty(p)) exports[p] = m[p];
}
Object.defineProperty(exports, "__esModule", { value: true });
__export(require("external"));
```

Where the `__export(require("external"))` statement is explicitly detected as a reexport, including variations `tslib.__export` and `__exportStar`.

### Environment Support

Node.js 10+, and [all browsers with Web Assembly support](https://caniuse.com/#feat=wasm).

### JS Grammar Support

* Token state parses all line comments, block comments, strings, template strings, blocks, parens and punctuators.
* Division operator / regex token ambiguity is handled via backtracking checks against punctuator prefixes, including closing brace or paren backtracking.
* Always correctly parses valid JS source, but may parse invalid JS source without errors.

### Benchmarks

Benchmarks can be run with `npm run bench`.

Current results:

JS Build:

```
Module load time
> 4ms
Cold Run, All Samples
test/samples/*.js (3635 KiB)
> 299ms

Warm Runs (average of 25 runs)
test/samples/angular.js (1410 KiB)
> 13.96ms
test/samples/angular.min.js (303 KiB)
> 4.72ms
test/samples/d3.js (553 KiB)
> 6.76ms
test/samples/d3.min.js (250 KiB)
> 4ms
test/samples/magic-string.js (34 KiB)
> 0.64ms
test/samples/magic-string.min.js (20 KiB)
> 0ms
test/samples/rollup.js (698 KiB)
> 8.48ms
test/samples/rollup.min.js (367 KiB)
> 5.36ms

Warm Runs, All Samples (average of 25 runs)
test/samples/*.js (3635 KiB)
> 40.28ms
```

Wasm Build:
```
Module load time
> 10ms
Cold Run, All Samples
test/samples/*.js (3635 KiB)
> 43ms

Warm Runs (average of 25 runs)
test/samples/angular.js (1410 KiB)
> 9.32ms
test/samples/angular.min.js (303 KiB)
> 3.16ms
test/samples/d3.js (553 KiB)
> 5ms
test/samples/d3.min.js (250 KiB)
> 2.32ms
test/samples/magic-string.js (34 KiB)
> 0.16ms
test/samples/magic-string.min.js (20 KiB)
> 0ms
test/samples/rollup.js (698 KiB)
> 6.28ms
test/samples/rollup.min.js (367 KiB)
> 3.6ms

Warm Runs, All Samples (average of 25 runs)
test/samples/*.js (3635 KiB)
> 27.76ms
```

### Wasm Build Steps

The build uses docker and make, they must be installed first.

To build the lexer wasm run `npm run build-wasm`. To build without docker, `npm run build-wasm-local`
downloads the same pinned wasi-sdk and binaryen releases into `build/toolchain` and builds with those.

Optimization passes are run with [Binaryen](https://github.com/WebAssembly/binaryen)
prior to publish to reduce the Web Assembly footprint.

After building the lexer wasm, build the final distribution components
(lexer.js and lexer.mjs) by running `npm run build`.

If you need to build lib/lexer.wat (optional) you must first install
[wabt](https://github.com/WebAssembly/wabt) as a sibling folder to this
project. The wat file is then build by running `make lib/lexer.wat`

### Creating a Release
These are the steps to create and publish a release. You will need docker
installed as well as having installed [wabt](https://github.com/WebAssembly/wabt)
as outlined above:

- [ ] Figure out if the release should be semver patch, minor or major based on the changes since
  the last release and determine the new version.
- [ ] Update the package.json version, and run a full build and test
  - npm install
  - npm run build
  - npm run test
- [ ] Commit and tag the changes, pushing up to main and the tag
  - For example
    - `git tag -a 1.4.2 -m "1.4.2"`
    - `git push origin tag 1.4.2`
- [ ] Create the GitHub release
- [ ] Run npm publish from an account with access (asking somebody with access
      the nodejs-foundation account is an option if you don't have access.
      
### License

MIT

[travis-url]: https://travis-ci.org/guybedford/es-module-lexer
[travis-image]: https://travis-ci.org/guybedford/es-module-lexer.svg?branch=master
