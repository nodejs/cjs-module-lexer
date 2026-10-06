const fs = require('node:fs');

const babel = require('@babel/core');
const terser = require('terser');

try { fs.mkdirSync('./dist'); }
catch (e) {}

const wasmBuffer = fs.readFileSync('./lib/lexer.wasm');
const jsSource = fs.readFileSync('./src/lexer.js').toString();
const pjson = JSON.parse(fs.readFileSync('./package.json').toString());

const jsSourceProcessed = jsSource.replace('WASM_BINARY', wasmBuffer.toString('base64'));

const minified = terser.minify_sync(jsSourceProcessed, {
  module: true,
  output: {
    preamble: `/* cjs-module-lexer ${pjson.version} */`
  }
});

fs.writeFileSync('./dist/lexer.mjs', minified.code);

const cjsSource = babel.transformSync(minified.code, {
  babelrc: false,
  configFile: false,
  plugins: [['@babel/plugin-transform-modules-commonjs', { strict: true }]]
}).code;
const cjsMinified = terser.minify_sync(cjsSource);

fs.writeFileSync('./dist/lexer.js', cjsMinified.code);
