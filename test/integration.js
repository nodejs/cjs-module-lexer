const fs = require('fs');
const assert = require('assert');

let parse;
async function loadParser () {
  if (parse) return;
  if (process.env.WASM) {
    const m = await import('../dist/lexer.mjs');
    await m.init();
    parse = m.parse;
  }
  else {
    parse = require('../lexer.js').parse;
  }
}

const files = fs.readdirSync('test/samples')
	.map(f => `test/samples/${f}`)
	.filter(x => x.endsWith('.js'))
	.map(file => {
		const source = fs.readFileSync(file);
		return {
			file,
			code: source.toString()
		};
	});

suite('Samples', () => {
  suiteSetup(async () => await loadParser());

  const selfSource = fs.readFileSync(process.cwd() + '/lexer.js').toString();
  test('Self test', async () => {
    const { exports } = parse(selfSource);
    assert.deepStrictEqual(exports, ['init', 'parse']);
  });

  files.forEach(({ file, code }) => {
    if (file.endsWith('magic-string.js') || file.endsWith('rollup.js'))
      return;
    test(file, async () => {
      try {
        var actual = Reflect.ownKeys(require(process.cwd() + '/' + file));
      }
      catch {}
      try {
        var { exports, reexports } = parse(code);
      }
      catch (err) {
        const lines = code.split('\n');
        const linesToErr = code.slice(0, err.loc).split('\n');
        
        const line = linesToErr.length - 1;
        const col = linesToErr.pop().length;

        let msg = `Parser error at ${line + 1}:${col} (${err.loc}).`;
        if (file.indexOf('min') == -1)
          msg += `\n${lines[line-1] || ''}\n${lines[line]}\n${' '.repeat(col)}^\n${lines[line + 1] || ''}`;

        throw new Error(msg);
      }
      if (actual && !file.endsWith('.min.js')) {
        for (const expt of actual)
          assert.ok(exports.includes(expt));
      }
    });
  });
});
