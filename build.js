const assert = require('assert');
const fs = require('fs');

const babel = require('@babel/core');
const terser = require('terser');

fs.mkdirSync('./dist', { recursive: true });

const wasmBuffer = fs.readFileSync('./lib/lexer.wasm');
const jsSource = fs.readFileSync('./src/lexer.js', 'utf8');
const { version } = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
const preamble = `/* cjs-module-lexer ${version} */`;
const inlineSource = jsSource.replace('WASM_BINARY', wasmBuffer.toString('base64'));
assert.ok(!inlineSource.includes('WASM_BINARY'), 'Unresolved inline Wasm marker.');

/**
 * @param {string} imports
 * @param {string} wasmBytes
 */
function renderExternal (imports, wasmBytes) {
  const loaderStartMarker = 'function getWasmBytes() {';
  const loaderStart = jsSource.indexOf(loaderStartMarker);
  assert.notStrictEqual(loaderStart, -1, 'Missing getWasmBytes function.');
  assert.strictEqual(
    jsSource.indexOf(loaderStartMarker, loaderStart + loaderStartMarker.length),
    -1,
    'Multiple getWasmBytes functions.'
  );
  const loaderEnd = jsSource.indexOf('\nlet initPromise;', loaderStart);
  assert.notStrictEqual(loaderEnd, -1, 'Missing getWasmBytes boundary.');
  return `${imports}\n${jsSource.slice(0, loaderStart)}function getWasmBytes() {\n` +
    `  return ${wasmBytes};\n}${jsSource.slice(loaderEnd)}`;
}

/**
 * @param {string} source
 * @param {boolean} isModule
 */
function minify (source, isModule) {
  const options = {
    module: isModule,
    output: { preamble }
  };
  const result = terser.minify(source, options);
  assert.ifError(result.error);
  return result.code;
}

/**
 * @param {string} filename
 * @param {string} source
 */
function buildEsm (filename, source) {
  fs.writeFileSync(`./dist/${filename}.mjs`, minify(source, true));
}

/**
 * @param {string} filename
 * @param {string} source
 */
function buildCjs (filename, source) {
  const cjsModuleSource = minify(source, true);
  const { code } = babel.transformSync(cjsModuleSource, { filename: `./dist/${filename}.mjs` });
  fs.writeFileSync(`./dist/${filename}.js`, minify(code, false));
}

buildEsm('lexer', inlineSource);
buildEsm(
  'lexer-external',
  renderExternal(
    `import { readFileSync } from 'fs';`,
    `readFileSync(new URL('../lib/lexer.wasm', import.meta.url))`
  )
);
buildCjs(
  'lexer-external',
  renderExternal(
    `import { readFileSync } from 'fs';\nimport { join } from 'path';`,
    `readFileSync(join(__dirname, '../lib/lexer.wasm'))`
  )
);
