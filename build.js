const fs = require('fs');
const terser = require('terser');

function buildCjsModuleLexer(filename, inline, minify) {
  try { fs.mkdirSync('./dist'); }
  catch (e) {}
  
  const wasmBuffer = fs.readFileSync('./lib/lexer.wasm');
  const jsSource = fs.readFileSync('./src/lexer.js').toString();
  const pjson = JSON.parse(fs.readFileSync('./package.json').toString());
  
  let jsSourceProcessed;
  if (inline) {
    jsSourceProcessed = jsSource.replace('WASM_BINARY', `(binary => typeof window !== 'undefined' && typeof atob === 'function' ? Uint8Array.from(atob(binary), x => x.charCodeAt(0)) : Buffer.from(binary, 'base64'))("${wasmBuffer.toString('base64')}")`);
  } else {
    jsSourceProcessed = jsSource.replace('WASM_BINARY', `(await import('node:fs')).readFileSync(new URL(import.meta.resolve('../lib/lexer.wasm')))`);
  }

  const minified = minify && terser.minify(jsSourceProcessed, {
    module: true,
    output: {
      preamble: `/* cjs-module-lexer ${pjson.version} */`
    }
  });
  
  if (minified.error)
    throw minified.error;
  
  fs.writeFileSync(`./dist/${filename}.mjs`, minified ? minified.code : jsSourceProcessed);
}

buildCjsModuleLexer('lexer', true, true);
buildCjsModuleLexer('lexer-external', false, false);