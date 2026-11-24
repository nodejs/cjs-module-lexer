const fs = require('node:fs');

const babel = require('@babel/core');
const terser = require('terser');

buildJSScanners();

function buildJSScanners () {
  const templatePath = './src/lexer-scan.js';
  const template = fs.readFileSync(templatePath, 'utf8');
  const { program } = babel.parseSync(template, { babelrc: false, configFile: false, sourceType: 'script' });
  const [scanner] = program.body;
  const [source, mode] = scanner?.params ?? [];
  if (program.body.length !== 1 || scanner.type !== 'FunctionDeclaration' || scanner.params.length !== 2 ||
      source?.type !== 'Identifier' || mode?.type !== 'Identifier') {
    throw new Error(`Expected a scanner with source and mode parameters in ${templatePath}.`);
  }
  const body = template.slice(scanner.body.start + 1, scanner.body.end);
  const variants = [];
  for (const [name, extended] of [['parseDefaultSource', false], ['parseExtendedSource', true]]) {
    const { code } = terser.minify_sync(`function ${name} (${source.name}) {\n  const ${mode.name} = ${extended};${body}`, {
      compress: {
        defaults: false,
        conditionals: true,
        dead_code: true,
        evaluate: true,
        passes: 2,
        reduce_vars: true,
        side_effects: true,
        unused: true
      },
      mangle: false,
      format: { beautify: true, indent_level: 2 }
    });
    variants.push(code);
  }

  const lexerPath = './lexer.js';
  const lexer = fs.readFileSync(lexerPath, 'utf8');
  const startMarker = '/* Generated from src/lexer-scan.js. */';
  const endMarker = '/* End generated scanners. */';
  const markerStart = lexer.indexOf(startMarker);
  const start = markerStart + startMarker.length;
  const end = lexer.indexOf(endMarker, start);
  if (markerStart === -1 || end === -1) throw new Error(`Missing generated scanner markers in ${lexerPath}.`);

  const newline = lexer.startsWith('\r\n', start) ? '\r\n' : '\n';
  const generated = `\n${variants.join('\n\n')}\n`.replaceAll('\n', newline);
  if (generated !== lexer.slice(start, end)) {
    fs.writeFileSync(lexerPath, lexer.slice(0, start) + generated + lexer.slice(end));
  }
}

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
