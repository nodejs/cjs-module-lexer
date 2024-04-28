const fs = require('fs');
const { buildSync } = require('esbuild');
const path = require('path/posix')

const { EXTERNAL_PATH } = process.env;
const MINIFY = !EXTERNAL_PATH;

try { fs.mkdirSync('./dist'); }
catch (e) {}

const wasmBuffer = fs.readFileSync('./lib/lexer.wasm');
const pjson = JSON.parse(fs.readFileSync('./package.json').toString());

buildSync({
  entryPoints: ['./src/lexer.js'],
  outfile: './dist/lexer.mjs',
  bundle: true,
  minify: MINIFY,
  platform: 'node',
  format: 'esm',
  banner: {
    js: `/* cjs-module-lexer ${pjson.version} */`
  },
  define: EXTERNAL_PATH ? {
    WASM_BINARY: 'undefined',
    EXTERNAL_PATH: `'${path.join(EXTERNAL_PATH, 'lib/lexer.wasm')}'`,
  } : {
    WASM_BINARY: `'${wasmBuffer.toString('base64')}'`,
    EXTERNAL_PATH: 'undefined'
  }
})

if (EXTERNAL_PATH) {
  buildSync({
    stdin: {
      contents: `'use strict';
let lazy;
async function init () {
  if (!lazy) {
    lazy = await import(require('node:url').pathToFileURL(require('node:module').createRequire('${EXTERNAL_PATH}/dist/lexer.js').resolve('./lexer.mjs')));
  }
  module.exports = lazy;
  return lazy.init();
}

function parse (source, name = '@') {
  if (!lazy)
    throw new Error('Not initialized');

  return lazy.parse(source, name);
}

module.exports = { init, parse };`,
      loader: 'js',
    },
    outfile: './dist/lexer.js',
    minify: MINIFY,
    platform: 'node',
    format: 'cjs',
  });
} else {
  buildSync({
    entryPoints: ['./dist/lexer.mjs'],
    outfile: './dist/lexer.js',
    minify: MINIFY,
    platform: 'node',
    format: 'cjs',
    banner: {
      js: `/* cjs-module-lexer ${pjson.version} */`
    }
  })
}

