# Webpack 5.112.0 fixtures

Both bundles use `target: 'node'`, `devtool: false`, `library.type: 'commonjs2'`,
and `optimization: { minimize: false, concatenateModules: false, usedExports: false }`.
Trailing horizontal whitespace is removed from the output.

`webpack-5.112-harmony.cjs` uses production mode with these inputs:

```js
// entry.mjs
export { depA as visible } from "./dep.mjs";
export const own = 1;

// dep.mjs
export const depA = globalThis.fixtureValue ?? 42;
export const internal = 43;
```

`webpack-5.112-ts-star.cjs` uses development mode with `ts-entry.js` as its entry.
Run `tsc --module commonjs --target es2018 ts-entry.ts ts-dep.ts unused.ts` with TypeScript 5.9.3 first.

```ts
// ts-entry.ts
import "./unused";
export * from "./ts-dep";
export const own = 1;

// ts-dep.ts
export const depA = 42;

// unused.ts
export const hidden = 1;
```
