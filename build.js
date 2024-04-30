const fs = require('fs');
const esbuild = require('esbuild');

let minify = true;
let cjsBuild = true;
let esmBuild = true;

for (const arg of process.argv) {
  switch (arg) {
    case '--without-cjs': {
      cjsBuild = false;
      break;
    }
    case '--without-esm': {
      esmBuild = false;
      break;
    }
    case '--no-minify': {
      minify = false;
      break;
    }
    default:
      continue;
  }
}

fs.mkdirSync('./dist', { recursive: true });

const wasmBuffer = fs.readFileSync('./lib/lexer.wasm');
const pjson = JSON.parse(fs.readFileSync('./package.json').toString());

/** @type {esbuild.BuildOptions} */
const buildOptions = {
  entryPoints: ['./src/lexer.js'],
  bundle: true,
  minify,
  platform: 'node',
  banner: {
    js: `/* cjs-module-lexer ${pjson.version} */`,
  },
  outfile: './dist/lexer.mjs',
  format: 'esm',
  define: {
    WASM_BINARY: `'${wasmBuffer.toString('base64')}'`,
  },
};

if (esmBuild) {
  // ESM builds are used when importing from npm.
  // Assume lib/lexer.wasm exists.
  esbuild.buildSync({
    ...buildOptions,
    define: {
      WASM_BINARY: 'undefined',
    },
  });
}

if (cjsBuild) {
  // CJS builds are used for libnode inlined builtins.
  esbuild.buildSync({
    ...buildOptions,
    outfile: './dist/lexer.js',
    format: 'cjs',
    logOverride: {
      'empty-import-meta': 'silent'
    },
  });
}
