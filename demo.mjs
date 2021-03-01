import { parse, init } from "./lexer.js";

await init();

const code = `
"use strict";

exports.__esModule = true;
var _exportNames = {
  named: true
};
exports.named = void 0;

var _reExport = require("./re-export");

Object.keys(_reExport).forEach(function (key) {
  if (key === "default" || key === "__esModule") return;
  if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
  if (key in exports && exports[key] === _reExport[key]) return;
  exports[key] = _reExport[key];
});
var named;
exports.named = named;
`

console.log(parse(code));