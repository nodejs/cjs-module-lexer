import { init, parse } from '../dist/lexer.mjs';

init().then(function () {
  const { exports, reexports } = parse('exports.value = 1');

  if (exports.length !== 1 || exports[0] !== 'value' || reexports.length !== 0)
    throw new Error('Unexpected parse result');
}).catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
