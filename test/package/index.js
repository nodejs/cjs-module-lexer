const assert = require('assert');
const { execFileSync } = require('child_process');
const {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync
} = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { pathToFileURL } = require('url');

/**
 * @param {string} entryName
 * @param {Buffer} [wasm]
 */
function createExternalFixture (entryName, wasm) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cjs-module-lexer-external-')));
  const entry = join(root, 'dist', entryName);
  const wasmPath = join(root, 'lib', 'lexer.wasm');
  mkdirSync(join(root, 'dist'), { recursive: true });
  copyFileSync(join(__dirname, '..', '..', 'dist', entryName), entry);
  if (wasm !== undefined) {
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(wasmPath, wasm);
  }
  return { entry, root, wasmPath };
}

/**
 * @param {string} directory
 */
function removeDirectory (directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      removeDirectory(path);
    } else {
      unlinkSync(path);
    }
  }
  rmdirSync(directory);
}

async function testExternalInitializers () {
  let fixture = createExternalFixture('lexer-external.js');
  try {
    const lexer = require(fixture.entry);
    assert.throws(() => lexer.initSync(), {
      code: 'ENOENT',
      path: fixture.wasmPath
    });
  } finally {
    removeDirectory(fixture.root);
  }

  fixture = createExternalFixture('lexer-external.mjs');
  try {
    const lexer = await import(pathToFileURL(fixture.entry).href);
    await assert.rejects(lexer.init(), {
      code: 'ENOENT',
      path: fixture.wasmPath
    });
  } finally {
    removeDirectory(fixture.root);
  }

  fixture = createExternalFixture('lexer-external.js', Buffer.from('invalid Wasm'));
  try {
    const lexer = require(fixture.entry);
    assert.throws(() => lexer.initSync(), WebAssembly.CompileError);
  } finally {
    removeDirectory(fixture.root);
  }

  fixture = createExternalFixture('lexer-external.mjs', Buffer.from('invalid Wasm'));
  try {
    const lexer = await import(pathToFileURL(fixture.entry).href);
    await assert.rejects(lexer.init(), WebAssembly.CompileError);
  } finally {
    removeDirectory(fixture.root);
  }
}

/**
 * @param {Error} error
 */
function reportError (error) {
  console.error(error);
  process.exitCode = 1;
}

const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'npm_execpath is required');

const output = execFileSync(process.execPath, [
  npmCli,
  'pack',
  '--dry-run',
  '--json',
  '--ignore-scripts'
], {
  encoding: 'utf8',
  env: {
    ...process.env,
    npm_config_cache: join(tmpdir(), 'cjs-module-lexer-npm-cache')
  }
});
const [{ files }] = JSON.parse(output);
const packedFiles = new Set();
for (const { path } of files) {
  packedFiles.add(path);
}

assert.ok(packedFiles.has('dist/lexer-external.js'));
assert.ok(packedFiles.has('dist/lexer-external.mjs'));
assert.ok(packedFiles.has('lib/lexer.wasm'));

testExternalInitializers().catch(reportError);
