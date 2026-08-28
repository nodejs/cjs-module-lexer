'use strict';

const assert = require('assert');
const fs = require('fs');

const result = require('../lexer.js').parse('exports.value = 1');
const wasm = new WebAssembly.Module(fs.readFileSync('lib/lexer.wasm'));

assert.deepStrictEqual(result.exports, ['value']);
assert.deepStrictEqual(result.reexports, []);
assert.strictEqual(typeof new WebAssembly.Instance(wasm).exports.parseCJS, 'function');
