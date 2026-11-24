const assert = require('node:assert/strict');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const { bmpStart, bmpContinueOnly, astralIdentifierStartCodes, astralIdentifierCodes } = require('./identifier-ranges.js');

const output = join(__dirname, '../include-wasm/identifier-data.h');
const masks = new Map();
const pages = new Map();

/**
 * @param {Uint8Array} membership
 * @param {number[][]} ranges
 */
function markRanges (membership, ranges) {
  let previousEnd = -1;
  for (const [first, last] of ranges) {
    assert.ok(Number.isInteger(first) && Number.isInteger(last) &&
      previousEnd < first && first <= last && last < membership.length, 'Invalid BMP identifier range');
    membership.fill(1, first, last + 1);
    previousEnd = last;
  }
}

/**
 * @param {Map<string, number>} table
 * @param {string} value
 */
function intern (table, value) {
  let index = table.get(value);
  if (index === undefined) {
    index = table.size;
    table.set(value, index);
  }
  return index;
}

/** @param {Uint8Array} membership */
function buildPageTable (membership) {
  const pageTable = [];
  for (let page = 0; page < 0x10000; page += 256) {
    const blocks = [];
    for (let block = 0; block < 256; block += 64) {
      let mask = 0n;
      for (let bit = 0; bit < 64; bit++) {
        if (membership[page + block + bit]) {
          mask |= 1n << BigInt(bit);
        }
      }
      blocks.push(intern(masks, `0x${mask.toString(16)}ull`));
    }
    pageTable.push(intern(pages, `{ ${blocks.join(', ')} }`));
  }
  return pageTable;
}

/**
 * @param {string} declaration
 * @param {(string | number)[]} values
 * @param {number} columns
 */
function formatTable (declaration, values, columns) {
  const lines = [];
  for (let index = 0; index < values.length; index += columns) {
    lines.push(`  ${values.slice(index, index + columns).join(', ')},`);
  }
  return `static const ${declaration} = {\n${lines.join('\n')}\n};`;
}

/**
 * @param {string} name
 * @param {number[]} codes
 */
function buildAstralTable (name, codes) {
  assert.equal(codes.length % 2, 0, `Expected range pairs for ${name}`);
  let position = 0x10000;
  let largest = 0;
  for (const code of codes) {
    assert.ok(Number.isInteger(code) && code >= 0, `Invalid range value for ${name}`);
    position += code;
    assert.ok(position <= 0x10ffff, `Range exceeds Unicode for ${name}`);
    largest = Math.max(largest, code);
  }
  const type = largest <= 0xffff ? 'uint16_t' : 'uint32_t';
  return formatTable(`${type} ${name}[]`, codes, 16);
}

const membership = new Uint8Array(0x10000);
markRanges(membership, bmpStart);
const startPages = buildPageTable(membership);
markRanges(membership, bmpContinueOnly);
const continuePages = buildPageTable(membership);
assert.ok(masks.size <= 256 && pages.size <= 256, 'Identifier data exceeds byte indices');

const generated = [
  formatTable('uint64_t bmpMasks[]', [...masks.keys()], 4),
  formatTable('uint8_t bmpPages[][4]', [...pages.keys()], 5),
  formatTable('uint8_t bmpStart[]', startPages, 24),
  formatTable('uint8_t bmpContinue[]', continuePages, 24),
  buildAstralTable('astralIdentifierStartCodes', astralIdentifierStartCodes),
  buildAstralTable('astralIdentifierCodes', astralIdentifierCodes),
].join('\n\n') + '\n';

if (process.argv[2] === '--check') {
  if (readFileSync(output, 'utf8') !== generated) {
    throw new Error('Run node build/identifier-data.js to update identifier data');
  }
} else {
  writeFileSync(output, generated);
}
