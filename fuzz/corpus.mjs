/**
 * @typedef {{ exports: string[], reexports: string[] }} ParseResult
 * @typedef {object} FuzzCase
 * @property {string} name
 * @property {string} source
 * @property {ParseResult} [expected]
 * @property {'structured' | 'metamorphic' | 'robustness'} kind
 */

/** @type {FuzzCase[]} */
export const corpus = [
  {
    name: 'direct-members',
    source: `
      exports.alpha = 1;
      module.exports['beta'] = 2;
    `,
    expected: { exports: ['alpha', 'beta'], reexports: [] },
    kind: 'structured'
  },
  {
    name: 'literal-and-spread',
    source: `
      module.exports = {
        alpha,
        'beta': value,
        ...require('dependency')
      };
    `,
    expected: { exports: ['alpha', 'beta'], reexports: ['dependency'] },
    kind: 'structured'
  },
  {
    name: 'define-property-getter',
    source: `
      Object.defineProperty(exports, 'alpha', {
        enumerable: true,
        get: function () { return binding.alpha; }
      });
    `,
    expected: { exports: ['alpha'], reexports: [] },
    kind: 'structured'
  },
  {
    name: 'object-keys-star-reexport',
    source: `
      var dependency = require('dependency');
      Object.keys(dependency).forEach(function (key) {
        if (key === 'default' || key === '__esModule') return;
        exports[key] = dependency[key];
      });
    `,
    expected: { exports: [], reexports: ['dependency'] },
    kind: 'structured'
  },
  {
    name: 'truncated-string',
    source: "exports['unterminated",
    kind: 'robustness'
  },
  {
    name: 'truncated-comment',
    source: 'module.exports = { alpha /*',
    kind: 'robustness'
  }
];
