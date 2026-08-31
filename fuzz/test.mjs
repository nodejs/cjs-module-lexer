import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';

import { generateCases, generationLimits } from './generate.mjs';
import { corpus } from './corpus.mjs';
import { parseArgs, runFuzz } from './index.mjs';
import { reduceSource } from './reduce.mjs';

const reductionSource = `exports.alpha = 1;\n${'void 0;\n'.repeat(20)}`;
const maximumTotalSourceBytes = 16 * 1024 * 1024;

const first = generateCases(1234, 40, 8192, 'all');
const second = generateCases(1234, 40, 8192, 'all');
assert.deepStrictEqual(first, second);
assert.notDeepStrictEqual(first, generateCases(1235, 40, 8192, 'all'));
assert.notDeepStrictEqual(
  generateCases(0, 40, 8192, 'all'),
  generateCases(1, 40, 8192, 'all')
);

assert.deepStrictEqual(
  parseArgs([
    '--target', '/tmp/target',
    '--seed', '0',
    '--cases', '1',
    '--max-bytes', '32',
    '--timeout-ms', '1',
    '--mode', 'structured',
    '--corpus', '/tmp/corpus.json'
  ]),
  {
    target: '/tmp/target',
    seed: 0,
    cases: 1,
    maximumSourceBytes: 32,
    timeoutMs: 1,
    mode: 'structured',
    corpusPath: '/tmp/corpus.json'
  }
);

const capped = generateCases(1, 20, 32, 'all');
for (let index = 0; index < capped.length; index++) {
  const fuzzCase = capped[index];
  assert.ok(Buffer.byteLength(fuzzCase.source) <= 32);
  assert.equal(fuzzCase.kind, ['structured', 'metamorphic', 'robustness'][index % 3]);
}
for (const fuzzCase of generateCases(1, 20, 32, 'structured')) assert.equal(fuzzCase.kind, 'structured');
for (const fuzzCase of generateCases(1, 20, 32, 'metamorphic')) assert.equal(fuzzCase.kind, 'metamorphic');

assert.throws(
  parseZeroCases,
  { name: 'RangeError' }
);
assert.throws(
  parseTooManyCases,
  { name: 'RangeError' }
);
assert.throws(
  parseZeroTimeout,
  { name: 'RangeError' }
);
assert.throws(
  parseUnknownMode,
  { message: 'unknown mode unknown' }
);
assert.throws(
  parseMissingValue,
  { message: 'missing value for --seed' }
);
assert.throws(
  parseUnknownOption,
  { message: 'unknown option --unknown' }
);
assert.throws(
  generateZeroCases,
  { name: 'RangeError' }
);
assert.throws(
  generateTooManyCases,
  { name: 'RangeError' }
);
assert.throws(
  generateTooSmallSource,
  { name: 'RangeError' }
);
assert.throws(
  generateTooLargeSource,
  { name: 'RangeError' }
);

const reduced = await reduceSource('prefix-FAIL-suffix', preservesFailure);
assert.equal(reduced, 'FAIL');
assert.equal(await reduceSource('x', preservesFailure), 'x');
let reductionAttempts = 0;
await reduceSource('x'.repeat(1024), () => {
  reductionAttempts++;
  return false;
}, 64);
assert.equal(reductionAttempts, 64);

const result = await runFuzz({
  target: process.cwd(),
  seed: 987654321,
  cases: 90,
  maximumSourceBytes: 8192,
  timeoutMs: 5000,
  mode: 'all'
});
assert.equal(result.generated, 90);

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'cjs-module-lexer-fuzz-'));
try {
  const corpusPath = join(temporaryDirectory, 'corpus.json');
  await writeFile(corpusPath, JSON.stringify([
    {
      name: 'external-corpus',
      source: 'exports.external = 1;',
      expected: { exports: ['external'], reexports: [] },
      kind: 'structured'
    }
  ]));
  const externalResult = await runFuzz({
    target: process.cwd(),
    seed: 7,
    cases: 1,
    maximumSourceBytes: 32,
    timeoutMs: 5000,
    mode: 'structured',
    corpusPath
  });
  assert.equal(externalResult.corpus, 7);

  await writeFile(corpusPath, JSON.stringify([
    {
      name: 'too-large',
      source: 'x'.repeat(33),
      kind: 'robustness'
    }
  ]));
  await assert.rejects(
    runFuzz({
      target: process.cwd(),
      seed: 7,
      cases: 1,
      maximumSourceBytes: 32,
      timeoutMs: 5000,
      mode: 'structured',
      corpusPath
    }),
    { name: 'RangeError', message: 'corpus case 0 exceeds max-bytes' }
  );

  await writeFile(corpusPath, '{}');
  await assertInvalidCorpus(corpusPath, { name: 'TypeError', message: 'external corpus must be an array' });

  await writeFile(corpusPath, '[null]');
  await assertInvalidCorpus(corpusPath, { name: 'TypeError', message: 'corpus case 0 must be an object' });

  await writeFile(corpusPath, JSON.stringify([{ name: 'missing-source', kind: 'robustness' }]));
  await assertInvalidCorpus(
    corpusPath,
    { name: 'TypeError', message: 'corpus case 0 must have string name and source fields' }
  );

  await writeFile(corpusPath, JSON.stringify([{ name: 'wrong-kind', source: '', kind: 'wrong' }]));
  await assertInvalidCorpus(corpusPath, { name: 'TypeError', message: 'corpus case 0 has an unknown kind' });

  await writeFile(corpusPath, JSON.stringify([{ name: 'missing-result', source: '', kind: 'structured' }]));
  await assertInvalidCorpus(
    corpusPath,
    { name: 'TypeError', message: 'corpus case 0 must have an expected result' }
  );

  await writeFile(corpusPath, Buffer.alloc(maximumTotalSourceBytes + 1));
  await assert.rejects(
    runFuzz({
      target: process.cwd(),
      seed: 7,
      cases: 1,
      maximumSourceBytes: 32,
      timeoutMs: 5000,
      mode: 'structured',
      corpusPath
    }),
    { name: 'RangeError', message: `external corpus cannot exceed ${maximumTotalSourceBytes} bytes` }
  );

  const tooManyCases = new Array(generationLimits.cases + 1);
  for (let index = 0; index < tooManyCases.length; index++) {
    tooManyCases[index] = { name: `case-${index}`, source: '', kind: 'robustness' };
  }
  await writeFile(corpusPath, JSON.stringify(tooManyCases));
  await assert.rejects(
    runFuzz({
      target: process.cwd(),
      seed: 7,
      cases: 1,
      maximumSourceBytes: 32,
      timeoutMs: 5000,
      mode: 'structured',
      corpusPath
    }),
    { name: 'RangeError', message: `external corpus cannot exceed ${generationLimits.cases} cases` }
  );

  const generatedForLimit = generateCases(7, generationLimits.cases, generationLimits.sourceBytes, 'structured');
  let sourceBytes = 0;
  for (const fuzzCase of corpus) sourceBytes += Buffer.byteLength(fuzzCase.source);
  for (const fuzzCase of generatedForLimit) sourceBytes += Buffer.byteLength(fuzzCase.source);
  let remainingBytes = maximumTotalSourceBytes - sourceBytes + 1;
  const totalLimitCases = [];
  while (remainingBytes > 0) {
    const size = Math.min(remainingBytes, generationLimits.sourceBytes);
    totalLimitCases.push({ name: `total-${totalLimitCases.length}`, source: 'x'.repeat(size), kind: 'robustness' });
    remainingBytes -= size;
  }
  await writeFile(corpusPath, JSON.stringify(totalLimitCases));
  await assert.rejects(
    runFuzz({
      target: process.cwd(),
      seed: 7,
      cases: generationLimits.cases,
      maximumSourceBytes: generationLimits.sourceBytes,
      timeoutMs: 5000,
      mode: 'structured',
      corpusPath
    }),
    { name: 'RangeError', message: `total source bytes cannot exceed ${maximumTotalSourceBytes}` }
  );

  await writeFile(join(temporaryDirectory, 'package.json'), JSON.stringify({ name: 'another-package' }));
  await assert.rejects(
    runFuzz({
      target: temporaryDirectory,
      seed: 7,
      cases: 1,
      maximumSourceBytes: 32,
      timeoutMs: 5000,
      mode: 'structured'
    }),
    { message: `target is not cjs-module-lexer: ${temporaryDirectory}` }
  );

  const fixtureTarget = join(process.cwd(), 'fuzz', 'fixtures', 'retained-target');
  process.env.CJS_FUZZ_REAL_JS = join(process.cwd(), 'lexer.js');
  process.env.CJS_FUZZ_REAL_WASM = join(process.cwd(), 'dist', 'lexer.mjs');
  process.env.CJS_FUZZ_REAL_WASM_SYNC = join(process.cwd(), 'dist', 'lexer.js');

  const retainedHandleResult = await runFuzz({
    target: fixtureTarget,
    seed: 9,
    cases: 3,
    maximumSourceBytes: 32,
    timeoutMs: 5000,
    mode: 'structured'
  });
  assert.equal(retainedHandleResult.generated, 3);

  await writeFile(corpusPath, JSON.stringify([
    {
      name: 'result-mismatch',
      source: 'result-mismatch',
      kind: 'robustness'
    }
  ]));
  const resultMismatch = await runFuzz({
    target: fixtureTarget,
    seed: 9,
    cases: 1,
    maximumSourceBytes: 32,
    timeoutMs: 5000,
    mode: 'structured',
    corpusPath
  });
  assert.equal(resultMismatch.generated, 1);

  await writeFile(corpusPath, JSON.stringify([
    {
      name: 'non-error',
      source: 'non-error',
      kind: 'robustness'
    }
  ]));
  const nonErrorResult = await runFuzz({
    target: fixtureTarget,
    seed: 9,
    cases: 1,
    maximumSourceBytes: 32,
    timeoutMs: 5000,
    mode: 'structured',
    corpusPath
  });
  assert.equal(nonErrorResult.generated, 1);

  await writeFile(corpusPath, JSON.stringify([
    {
      name: 'worker-exit',
      source: 'worker-exit',
      expected: { exports: [], reexports: [] },
      kind: 'structured'
    }
  ]));
  await assert.rejects(
    runFuzz({
      target: fixtureTarget,
      seed: 9,
      cases: 1,
      maximumSourceBytes: 32,
      timeoutMs: 5000,
      mode: 'structured',
      corpusPath
    }),
    /worker exited with code 7 at case/
  );

  process.env.CJS_FUZZ_INITIALIZATION = 'error';
  await assert.rejects(
    runFuzz({
      target: fixtureTarget,
      seed: 9,
      cases: 1,
      maximumSourceBytes: 32,
      timeoutMs: 5000,
      mode: 'structured'
    }),
    { message: 'fixture initialization error' }
  );
  process.env.CJS_FUZZ_INITIALIZATION = 'exit';
  await assert.rejects(
    runFuzz({
      target: fixtureTarget,
      seed: 9,
      cases: 1,
      maximumSourceBytes: 32,
      timeoutMs: 5000,
      mode: 'structured'
    }),
    /worker exited with code 7 during initialization/
  );
  delete process.env.CJS_FUZZ_INITIALIZATION;

  const multipleResolves = [];
  const onMultipleResolve = Array.prototype.push.bind(multipleResolves);
  process.on('multipleResolves', onMultipleResolve);
  try {
    process.env.CJS_FUZZ_INITIALIZATION = 'error';
    await assert.rejects(
      runFuzz({
        target: fixtureTarget,
        seed: 9,
        cases: 1,
        maximumSourceBytes: 32,
        timeoutMs: 1,
        mode: 'structured'
      }),
      /worker timed out at case/
    );
    await setImmediate();
    await setImmediate();
    assert.deepStrictEqual(multipleResolves, []);
  } finally {
    delete process.env.CJS_FUZZ_INITIALIZATION;
    process.off('multipleResolves', onMultipleResolve);
  }

  await writeFile(corpusPath, JSON.stringify([
    {
      name: 'worker-timeout',
      source: 'worker-timeout',
      expected: { exports: [], reexports: [] },
      kind: 'structured'
    }
  ]));
  await assert.rejects(
    runFuzz({
      target: fixtureTarget,
      seed: 9,
      cases: 1,
      maximumSourceBytes: 32,
      timeoutMs: 50,
      mode: 'structured',
      corpusPath
    }),
    /worker timed out at case/
  );

  for (const mode of ['js', 'wasm', 'wasm-sync']) {
    await assertRuntimeError(corpusPath, fixtureTarget, mode);
  }

  await writeFile(corpusPath, JSON.stringify([
    {
      name: 'reduction',
      source: reductionSource,
      expected: { exports: ['wrong'], reexports: [] },
      kind: 'structured'
    }
  ]));
  await assert.rejects(
    runFuzz({
      target: process.cwd(),
      seed: 9,
      cases: 1,
      maximumSourceBytes: 1024,
      timeoutMs: 5000,
      mode: 'structured',
      corpusPath
    }),
    hasReducedSource
  );

  const cliSuccess = spawnSync(process.execPath, ['fuzz/index.mjs', '--cases', '1', '--mode', 'structured'], {
    cwd: process.cwd(),
    encoding: 'utf8'
  });
  assert.equal(cliSuccess.status, 0);
  assert.match(cliSuccess.stdout, /fuzz ok seed=1 generated=1 corpus=6/);

  const cliFuzzFailure = spawnSync(process.execPath, [
    'fuzz/index.mjs',
    '--corpus', corpusPath,
    '--cases', '1',
    '--mode', 'structured'
  ], {
    cwd: process.cwd(),
    encoding: 'utf8'
  });
  assert.equal(cliFuzzFailure.status, 1);
  assert.match(cliFuzzFailure.stderr, /fuzz failed seed=1 details=/);

  const cliFailure = spawnSync(process.execPath, [
    'fuzz/index.mjs',
    '--target', temporaryDirectory,
    '--cases', '1',
    '--mode', 'structured'
  ], {
    cwd: process.cwd(),
    encoding: 'utf8'
  });
  assert.equal(cliFailure.status, 1);
  assert.match(cliFailure.stderr, /fuzz failed seed=1 details=/);
} finally {
  delete process.env.CJS_FUZZ_REAL_JS;
  delete process.env.CJS_FUZZ_REAL_WASM;
  delete process.env.CJS_FUZZ_REAL_WASM_SYNC;
  delete process.env.CJS_FUZZ_INITIALIZATION;
  await rm(temporaryDirectory, { recursive: true, force: true });
}

console.log('fuzzer self-test ok');

/**
 * @param {string} candidate
 */
function preservesFailure (candidate) {
  return candidate.includes('FAIL');
}

function parseZeroCases () {
  parseArgs(['--cases', '0']);
}

function parseTooManyCases () {
  parseArgs(['--cases', String(generationLimits.cases + 1)]);
}

function parseZeroTimeout () {
  parseArgs(['--timeout-ms', '0']);
}

function parseUnknownMode () {
  parseArgs(['--mode', 'unknown']);
}

function parseMissingValue () {
  parseArgs(['--seed']);
}

function parseUnknownOption () {
  parseArgs(['--unknown', 'value']);
}

function generateZeroCases () {
  generateCases(1, 0, 32, 'all');
}

function generateTooManyCases () {
  generateCases(1, generationLimits.cases + 1, 32, 'all');
}

function generateTooSmallSource () {
  generateCases(1, 1, 31, 'all');
}

function generateTooLargeSource () {
  generateCases(1, 1, generationLimits.sourceBytes + 1, 'all');
}

/**
 * @param {Error & { source?: string }} error
 */
function hasReducedSource (error) {
  return error.message.includes('"exports":["wrong"]') &&
    typeof error.source === 'string' && error.source.length < reductionSource.length;
}

/**
 * @param {string} corpusPath
 * @param {{ name: string, message: string }} expected
 */
async function assertInvalidCorpus (corpusPath, expected) {
  await assert.rejects(
    runFuzz({
      target: process.cwd(),
      seed: 7,
      cases: 1,
      maximumSourceBytes: 32,
      timeoutMs: 5000,
      mode: 'structured',
      corpusPath
    }),
    expected
  );
}

/**
 * @param {string} corpusPath
 * @param {string} fixtureTarget
 * @param {string} mode
 */
async function assertRuntimeError (corpusPath, fixtureTarget, mode) {
  await writeFile(corpusPath, JSON.stringify([
    {
      name: `runtime-error-${mode}`,
      source: `runtime-error-${mode}`,
      kind: 'robustness'
    }
  ]));
  await assert.rejects(
    runFuzz({
      target: fixtureTarget,
      seed: 9,
      cases: 1,
      maximumSourceBytes: 32,
      timeoutMs: 5000,
      mode: 'structured',
      corpusPath
    }),
    { message: new RegExp(`${mode} returned a RuntimeError`) }
  );
}
