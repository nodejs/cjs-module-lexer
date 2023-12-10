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

suite('Lexer', () => {
  suiteSetup(async () => await loadParser());

  test('esm syntax error', () => {
    try {
      parse(`
        import 'x';
      `);
      assert(false);
    } catch (e) {
      assert(e.code === 'ERR_LEXER_ESM_SYNTAX');
    }

    try {
      parse(`
        export { x };
      `);
      assert(false);
    } catch (e) {
      assert(e.code === 'ERR_LEXER_ESM_SYNTAX');
    }

    try {
      parse(`
        syntax?error;

        export function x () {

        }
      `);
      assert(false);
    } catch (e) {
      assert(e.code === 'ERR_LEXER_ESM_SYNTAX');
    }

    try {
      parse(`
        import.meta.url
      `);
      assert(false);
    } catch (e) {
      assert(e.code === 'ERR_LEXER_ESM_SYNTAX');
    }
  });

  test('esbuild hint style', () => {
    var { exports, reexports } = parse(`
      0 && (module.exports = {a, b, c}) && __exportStar(require('fs'));
    `);

    assert.equal(exports.length, 3);
    assert.equal(exports[0], 'a');
    assert.equal(exports[1], 'b');
    assert.equal(exports[2], 'c');
    assert.equal(reexports.length, 1);
    assert.equal(reexports[0], 'fs');
  });

  test('Getter opt-outs', () => {
    var { exports } = parse(`
      Object.defineProperty(exports, 'a', {
        enumerable: true,
        get: function () {
          return q.p;
        }
      });

      if (false) {
        Object.defineProperty(exports, 'a', {
          enumerable: false,
          get: function () {
            return dynamic();
          }
        });
      }
    `);

    assert.equal(exports.length, 0);
  });

  test('TypeScript reexports', () => {
    var { exports, reexports } = parse(` 
      "use strict";
      function __export(m) {
          for (var p in m) if (!exports.hasOwnProperty(p)) exports[p] = m[p];
      }
      Object.defineProperty(exports, "__esModule", { value: true });
      __export(require("external1"));
      tslib.__export(require("external2"));
      __exportStar(require("external3"));
      tslib1.__exportStar(require("external4"));

      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      var color_factory_1 = require("./color-factory");
      Object.defineProperty(exports, "colorFactory", { enumerable: true, get: function () { return color_factory_1.colorFactory; }, });
    `);
    assert.equal(exports.length, 2);
    assert.equal(exports[0], '__esModule');
    assert.equal(exports[1], 'colorFactory');
    assert.equal(reexports.length, 4);
    assert.equal(reexports[0], 'external1');
    assert.equal(reexports[1], 'external2');
    assert.equal(reexports[2], 'external3');
    assert.equal(reexports[3], 'external4');
  });

  test('Rollup Babel reexport getter', () => {
    var { exports } = parse(`
      Object.defineProperty(exports, 'a', {
        enumerable: true,
        get: function () {
          return q.p;
        }
      });

      Object.defineProperty(exports, 'b', {
        enumerable: false,
        get: function () {
          return q.p;
        }
      });

      Object.defineProperty(exports, "c", {
        get: function get () {
          return q['p' ];
        }
      });

      Object.defineProperty(exports, 'd', {
        get: function () {
          return __ns.val;
        }
      });

      Object.defineProperty(exports, 'e', {
        get () {
          return external;
        }
      });

      Object.defineProperty(exports, "f", {
        get: functionget () {
          return q['p' ];
        }
      });
    `);
    assert.equal(exports.length, 4);
    assert.equal(exports[0], 'a');
    assert.equal(exports[1], 'c');
    assert.equal(exports[2], 'd');
    assert.equal(exports[3], 'e');
  });

  test('Rollup Babel reexports', () => {
    var { exports, reexports } = parse(`
      "use strict";

      exports.__esModule = true;

      not.detect = require("ignored");

      var _external = require("external");

      // Babel <7.12.0, loose mode
      Object.keys(_external).forEach(function (key) {
        if (key === "default" || key === "__esModule") return;
        exports[key] = _external[key];
      });

      var _external2 = require("external2");

      // Babel <7.12.0
      Object.keys(_external2).forEach(function (key) {
        if (key === "default" || /*comment!*/ key === "__esModule") return;
        Object.defineProperty(exports, key, {
          enumerable: true,
          get: function () {
            return _external2[key];
          }
        });
      });

      var _external001 = require("external001");

      // Babel >=7.12.0, loose mode
      Object.keys(_external001).forEach(function (key) {
        if (key === "default" || key === "__esModule") return;
        if (key in exports && exports[key] === _external001[key]) return;
        exports[key] = _external001[key];
      });

      var _external003 = require("external003");

      // Babel >=7.12.0, loose mode, reexports conflicts filter
      Object.keys(_external003).forEach(function (key) {
        if (key === "default" || key === "__esModule") return;
        if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
        if (key in exports && exports[key] === _external003[key]) return;
        exports[key] = _external003[key];
      });

      var _external002 = require("external002");

      // Babel >=7.12.0
      Object.keys(_external002).forEach(function (key) {
        if (key === "default" || key === "__esModule") return;
        if (key in exports && exports[key] === _external002[key]) return;
        Object.defineProperty(exports, key, {
          enumerable: true,
          get: function () {
            return _external002[key];
          }
        });
      });

      var _external004 = require("external004");

      // Babel >=7.12.0, reexports conflict filter
      Object.keys(_external004).forEach(function (key) {
        if (key === "default" || key === "__esModule") return;
        if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
        if (key in exports && exports[key] === _external004[key]) return;
        Object.defineProperty(exports, key, {
          enumerable: true,
          get: function () {
            return _external004[key];
          }
        });
      });

      let external3 = require('external3');
      const external4 = require('external4');

      Object.keys(external3).forEach(function (k) {
        if (k !== 'default') Object.defineProperty(exports, k, {
          enumerable: true,
          get: function () {
            return external3[k];
          }
        });
      });
      Object.keys(external4).forEach(function (k) {
        if (k !== 'default') exports[k] = external4[k];
      });

      const externalǽ = require('external😃');
      Object.keys(externalǽ).forEach(function (k) {
        if (k !== 'default') exports[k] = externalǽ[k];
      });

      let external5 = require('e5');
      let external6 = require('e6');
      Object.keys(external5).forEach(function (k) {
        if (k !== 'default' && !Object.hasOwnProperty.call(exports, k)) exports[k] = external5[k];
      });

      const not = require('not');
      Object.keys(not).forEach(function (k) {
        if (k !== 'default' && !a().hasOwnProperty(k)) exports[k] = not[k];
      });

      Object.keys(external6).forEach(function (k) {
        if (k !== 'default' && !exports.hasOwnProperty(k)) exports[k] = external6[k];
      });

      const external𤭢 = require('external𤭢');
      Object.keys(external𤭢).forEach(function (k) {
        if (k !== 'default') exports[k] = external𤭢[k];
      });

      const notexternal1 = require('notexternal1');
      Object.keys(notexternal1);

      const notexternal2 = require('notexternal2');
      Object.keys(notexternal2).each(function(){
      });

      const notexternal3 = require('notexternal3');
      Object.keys(notexternal2).forEach(function () {
      });

      const notexternal4 = require('notexternal4');
      Object.keys(notexternal2).forEach(function (x) {
      });

      const notexternal5 = require('notexternal5');
      Object.keys(notexternal5).forEach(function (x) {
        if (true);
      });

      const notexternal6 = require('notexternal6');
      Object.keys(notexternal6).forEach(function (x) {
        if (x);
      });

      const notexternal7 = require('notexternal7');
      Object.keys(notexternal7).forEach(function(x){
        if (x ==='default');
      });

      const notexternal8 = require('notexternal8');
      Object.keys(notexternal8).forEach(function(x){
        if (x ==='default'||y);
      });

      const notexternal9 = require('notexternal9');
      Object.keys(notexternal9).forEach(function(x){
        if (x ==='default'||x==='__esM');
      });

      const notexternal10 = require('notexternal10');
      Object.keys(notexternal10).forEach(function(x){
        if (x !=='default') return
      });

      const notexternal11 = require('notexternal11');
      Object.keys(notexternal11).forEach(function(x){
        if (x ==='default'||x==='__esModule') return
      });

      const notexternal12 = require('notexternal12');
      Object.keys(notexternal12).forEach(function(x){
        if (x ==='default'||x==='__esModule') return
        export[y] = notexternal12[y];
      });

      const notexternal13 = require('notexternal13');
      Object.keys(notexternal13).forEach(function(x){
        if (x ==='default'||x==='__esModule') return
        exports[y] = notexternal13[y];
      });

      const notexternal14 = require('notexternal14');
      Object.keys(notexternal14).forEach(function(x){
        if (x ==='default'||x==='__esModule') return
        Object.defineProperty(exports, k, {
          enumerable: false,
          get: function () {
            return external14[k];
          }
        });
      });

      const notexternal15 = require('notexternal15');
      Object.keys(notexternal15).forEach(function(x){
        if (x ==='default'||x==='__esModule') return
        Object.defineProperty(exports, k, {
          enumerable: false,
          get: function () {
            return externalnone[k];
          }
        });
      });

      const notexternal16 = require('notexternal16');
      Object.keys(notexternal16).forEach(function(x){
        if (x ==='default'||x==='__esModule') return
        exports[x] = notexternal16[x];
        extra;
      });

      {
        const notexternal17 = require('notexternal17');
        Object.keys(notexternal17).forEach(function(x){
          if (x ==='default'||x==='__esModule') return
          exports[x] = notexternal17[x];
        });
      }

      var _styles = require("./styles");
      Object.keys(_styles).forEach(function (key) {
        if (key === "default" || key === "__esModule") return;
        if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
        Object.defineProperty(exports, key, {
          enumerable: true,
          get: function get() {
            return _styles[key];
          }
        });
      });

      var _styles2 = require("./styles2");
      Object.keys(_styles2).forEach(function (key) {
        if (key === "default" || key === "__esModule") return;
        if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
        Object.defineProperty(exports, key, {
          enumerable: true,
          get () {
            return _styles2[key];
          }
        });
      });

      var _Accordion = _interopRequireWildcard(require("./Accordion"));
      Object.keys(_Accordion).forEach(function (key) {
        if (key === "default" || key === "__esModule") return;
        if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
        Object.defineProperty(exports, key, {
          enumerable: true,
          get: function () {
            return _Accordion[key];
          }
        });
      });
    `);
    assert.equal(exports.length, 1);
    assert.equal(exports[0], '__esModule');
    assert.equal(reexports.length, 15);
    assert.equal(reexports[0], 'external');
    assert.equal(reexports[1], 'external2');
    assert.equal(reexports[2], 'external001');
    assert.equal(reexports[3], 'external003');
    assert.equal(reexports[4], 'external002');
    assert.equal(reexports[5], 'external004');
    assert.equal(reexports[6], 'external3');
    assert.equal(reexports[7], 'external4');
    assert.equal(reexports[8], 'external😃');
    assert.equal(reexports[9], 'e5');
    assert.equal(reexports[10], 'e6');
    assert.equal(reexports[11], 'external𤭢');
    assert.equal(reexports[12], './styles');
    assert.equal(reexports[13], './styles2');
    assert.equal(reexports[14], './Accordion');
  });

  test('module exports reexport spread', () => {
    const { exports, reexports } = parse(`
      module.exports = {
        ...a,
        ...b,
        ...require('dep1'),
        c: d,
        ...require('dep2'),
        name
      };
    `);
    assert.equal(exports.length, 2);
    assert.equal(exports[0], 'c');
    assert.equal(exports[1], 'name');
    assert.equal(reexports.length, 2);
    assert.equal(reexports[0], 'dep1');
    assert.equal(reexports[1], 'dep2');
  });

  test('Regexp case', () => {
    parse(`
      class Number {

      }
      
      /("|')(?<value>(\\\\(\\1)|[^\\1])*)?(\\1)/.exec(\`'\\\\"\\\\'aa'\`);
      
      const x = \`"\${label.replace(/"/g, "\\\\\\"")}"\`
    `);
  });

  test('Regexp division', () => {
    parse(`\nconst x = num / /'/.exec(l)[0].slice(1, -1)//'"`);
  });

  test('Multiline string escapes', () => {
    parse("const str = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAB4AAAAeCAYAAAA7MK6iAAAABmJLR0QA/wAAAAAzJ3zzAAAGTElEQV\\\r\n\t\tRIx+VXe1BU1xn/zjn7ugvL4sIuQnll5U0ELAQxig7WiQYz6NRHa6O206qdSXXSxs60dTK200zNY9q0dcRpMs1jkrRNWmaijCVoaU';\r\n");
  });

  test('Dotted number', () => {
    parse(`
       const x = 5. / 10;
    `);
  });

  test('Division operator case', () => {
    parse(`
      function log(r){
        if(g>=0){u[g++]=m;g>=n.logSz&&(g=0)}else{u.push(m);u.length>=n.logSz&&(g=0)}/^(DBG|TICK): /.test(r)||t.Ticker.tick(454,o.slice(0,200));
      }
      
      (function(n){
      })();
    `);
  });

  test('Single parse cases', () => {
    parse(`'asdf'`);
    parse(`/asdf/`);
    parse(`\`asdf\``);
    parse(`/**/`);
    parse(`//`);
  });

  test('shebang', () => {
    var { exports } = parse(`#!`);
    assert.equal(exports.length, 0);
    
    var { exports } = parse(`#! (  {
      exports.asdf = 'asdf';
    `);
    assert.equal(exports.length, 1);
    assert.equal(exports[0], 'asdf');
  });

  test('module.exports', () => {
    const { exports } = parse(`
      module.exports.asdf = 'asdf';
    `);
    assert.equal(exports.length, 1);
    assert.equal(exports[0], 'asdf');
  });

  test('non-identifiers', () => {
    const { exports } = parse(`
      module.exports = { 'ab cd': foo };
      exports['not identifier'] = 'asdf';
      exports['\\u{D83C}\\u{DF10}'] = 1;
      exports['\\u{D83C}'] = 1;
      exports['\\''] = 1;
      exports['@notidentifier'] = 'asdf';
      Object.defineProperty(exports, "%notidentifier", { value: x });
      Object.defineProperty(exports, 'hm🤔', { value: x });
      exports['⨉'] = 45;
      exports['α'] = 54;
      exports.package = 'STRICT RESERVED!';
      exports.var = 'RESERVED';
    `);
    assert.deepStrictEqual(exports, [
      'ab cd',
      'not identifier',
      '\u{D83C}\u{DF10}',
      '\'',
      '@notidentifier',
      '%notidentifier',
      'hm🤔',
      '⨉',
      'α',
      'package',
      'var'
    ]);
  });

  test('Literal exports', () => {
    const { exports } = parse(`
      module.exports = { a, b: c, d, 'e': f };
    `);
    assert.equal(exports.length, 4);
    assert.equal(exports[0], 'a');
    assert.equal(exports[1], 'b');
    assert.equal(exports[2], 'd');
    assert.equal(exports[3], 'e');
  });

  test('Literal exports unsupported', () => {
    const { exports } = parse(`
      module.exports = { a = 5, b };
    `);
    assert.equal(exports.length, 1);
    assert.equal(exports[0], 'a');
  });

  test('Literal exports example', () => {
    const { exports } = parse(`
      module.exports = {
        // These WILL be detected as exports
        a: a,
        b: b,
        
        // This WILL be detected as an export
        e: require('d'),
      
        // These WONT be detected as exports
        // because the object parser stops on the non-identifier
        // expression "require('d')"
        f: 'f'
      }
    `);
    assert.equal(exports.length, 3);
    assert.equal(exports[2], 'e');
  });

  test('Literal exports complex', () => {
    const { exports } = parse(`    
      function defineProp(name, value) {
        delete module.exports[name];
        module.exports[name] = value;
        return value;
      }
    
      module.exports = {
        Parser: Parser,
        Tokenizer: require("./Tokenizer.js"),
        ElementType: require("domelementtype"),
        DomHandler: DomHandler,
        get FeedHandler() {
            return defineProp("FeedHandler", require("./FeedHandler.js"));
        },
        get Stream() {
            return defineProp("Stream", require("./Stream.js"));
        },
        get WritableStream() {
            return defineProp("WritableStream", require("./WritableStream.js"));
        },
        get ProxyHandler() {
            return defineProp("ProxyHandler", require("./ProxyHandler.js"));
        },
        get DomUtils() {
            return defineProp("DomUtils", require("domutils"));
        },
        get CollectingHandler() {
            return defineProp(
                "CollectingHandler",
                require("./CollectingHandler.js")
            );
        },
        // For legacy support
        DefaultHandler: DomHandler,
        get RssHandler() {
            return defineProp("RssHandler", this.FeedHandler);
        },
        //helper methods
        parseDOM: function(data, options) {
            var handler = new DomHandler(options);
            new Parser(handler, options).end(data);
            return handler.dom;
        },
        parseFeed: function(feed, options) {
            var handler = new module.exports.FeedHandler(options);
            new Parser(handler, options).end(feed);
            return handler.dom;
        },
        createDomStream: function(cb, options, elementCb) {
            var handler = new DomHandler(cb, options, elementCb);
            return new Parser(handler, options);
        },
        // List of all events that the parser emits
        EVENTS: {
            /* Format: eventname: number of arguments */
            attribute: 2,
            cdatastart: 0,
            cdataend: 0,
            text: 1,
            processinginstruction: 2,
            comment: 1,
            commentend: 0,
            closetag: 1,
            opentag: 2,
            opentagname: 1,
            error: 1,
            end: 0
        }
      };
    `);
    assert.equal(exports.length, 2);
    assert.equal(exports[0], 'Parser');
    assert.equal(exports[1], 'Tokenizer');
  });

  test('defineProperty value', () => {
    const { exports } = parse(`
      Object.defineProperty(exports, 'namedExport', { enumerable: false, value: true });
      Object.defineProperty(exports, 'namedExport', { configurable: false, value: true });

      Object.defineProperty(exports, 'a', {
        enumerable: false,
        get () {
          return p;
        }
      });
      Object.defineProperty(exports, 'b', {
        configurable: true,
        get () {
          return p;
        }
      });
      Object.defineProperty(exports, 'c', {
        get: () => p
      });
      Object.defineProperty(exports, 'd', {
        enumerable: true,
        get: function () {
          return dynamic();
        }
      });
      Object.defineProperty(exports, 'e', {
        enumerable: true,
        get () {
          return 'str';
        }
      });

      Object.defineProperty(module.exports, 'thing', { value: true });
      Object.defineProperty(exports, "other", { enumerable: true, value: true });
      Object.defineProperty(exports, "__esModule", { value: true });
    `);
    assert.equal(exports.length, 3);
    assert.equal(exports[0], 'thing');
    assert.equal(exports[1], 'other');
    assert.equal(exports[2], '__esModule');
  });

  test('module assign', () => {
    const { exports, reexports } = parse(`
      module.exports.asdf = 'asdf';
      exports = 'asdf';
      module.exports = require('./asdf');
      if (maybe)
        module.exports = require("./another");
    `);
    assert.equal(exports.length, 1);
    assert.equal(exports[0], 'asdf');
    assert.equal(reexports.length, 1);
    assert.equal(reexports[0], './another');
  });

  test('Single parse cases', () => {
    parse(`'asdf'`);
    parse(`/asdf/`);
    parse(`\`asdf\``);
    parse(`/**/`);
    parse(`//`);
  });

  test('Simple export with unicode conversions', () => {
    const source = `export var p𓀀s,q`;
    assert.throws(() => {
      parse(source);
    });
  });

  test('Simple import', () => {
    const source = `
      import test from "test";
      console.log(test);
    `;
    assert.throws(() => {
      parse(source);
    });
  });

  test('Exported function', () => {
    const source = `
      export function a𓀀 () {

      }
      export class Q{

      }
    `;
    assert.throws(() => {
      parse(source);
    });
  });

  test('Export destructuring', () => {
    const source = `
      export const { a, b } = foo;

      export { ok };
    `;
    assert.throws(() => {
      parse(source);
    });
  });

  test('Minified import syntax', () => {
    const source = `import{TemplateResult as t}from"lit-html";import{a as e}from"./chunk-4be41b30.js";export{j as SVGTemplateResult,i as TemplateResult,g as html,h as svg}from"./chunk-4be41b30.js";window.JSCompiler_renameProperty='asdf';`;
    assert.throws(() => {
      parse(source);
    });
  });

  test('plus plus division', () => {
    parse(`
      tick++/fetti;f=(1)+")";
    `);
  });

  test('return bracket division', () => {
    const source = `function variance(){return s/(a-1)}`;
    assert.ok(parse(source));
  });

  test('import.meta', () => {
    const source = `
      export var hello = 'world';
      console.log(import.meta.url);
    `;
    assert.throws(() => {
      parse(source);
    });
  });

  test('import meta edge cases', () => {
    const source = `
      // Import meta
      import.
       meta
      // Not import meta
      a.
      import.
        meta
    `;
    assert.throws(() => {
      parse(source);
    });
  });

  test('dynamic import method', async () => {
    const source = `
      class A {
        import() {
        }
      }
    `;
    assert.ok(parse(source));
  });

  test('Comments', () => {
    const source = `/*
    VERSION
  */import util from 'util';

//
function x() {
}

      /**/
      // '
      /* / */
      /*

         * export { b }
      \\*/export { a }

      function () {
        /***/
      }
    `
    assert.throws(() => {
      parse(source);
    });
  });

  test('Bracket matching', () => {
    assert.ok(parse(`
      instance.extend('parseExprAtom', function (nextMethod) {
        return function () {
          function parseExprAtom(refDestructuringErrors) {
            if (this.type === tt._import) {
              return parseDynamicImport.call(this);
            }
            return c(refDestructuringErrors);
          }
        }();
      });
    `));
  });

  test('Division / Regex ambiguity', () => {
    const source = `
      /as)df/; x();
      a / 2; '  /  '
      while (true)
        /test'/
      x-/a'/g
      try {}
      finally{}/a'/g
      (x);{f()}/d'export { b }/g
      ;{}/e'/g;
      {}/f'/g
      a / 'b' / c;
      /a'/ - /b'/;
      +{} /g -'/g'
      ('a')/h -'/g'
      if //x
      ('a')/i'/g;
      /asdf/ / /as'df/; // '
      p = \`\${/test/ + 5}\`;
      /regex/ / x;
      function m() {
        return /*asdf8*// 5/;
      }
    `;
    assert.ok(parse(source));
  });

  test('Template string expression ambiguity', () => {
    const source = `
      \`$\`
      import('a');
      \`\`
      exports.a = 'a';
      \`a$b\`
      exports['b'] = 'b';
      \`{$}\`
      exports['b'].b;
    `;
    const { exports } = parse(source);
    assert.ok(exports[0] === 'a');
    assert.ok(exports[1] === 'b');
  });
});
