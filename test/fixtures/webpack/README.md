# Webpack 5.112.0 fixtures

All bundles use `target: 'node'`, `devtool: false`, `library.type: 'commonjs2'`,
and `optimization.minimize: false`.
Trailing horizontal whitespace is removed from the output.

The harmony and ts-star bundles also set `optimization.concatenateModules` and
`optimization.usedExports` to `false`.

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

`webpack-5.112-ts-direct.cjs` uses production mode with `direct-entry.js` as its
entry. Run `tsc --module commonjs --target es2018 direct-entry.ts` first.

```ts
// direct-entry.ts
export const helper = () => 1;
export const own = helper();
```

`webpack-5.112-dynamic-star.cjs` uses production mode with `dynamic-entry.mjs` as
its entry. Run `tsc --module commonjs --target es2018 dynamic-barrel.ts dynamic-dep.ts`
first.

```js
// dynamic-entry.mjs
export * from "./dynamic-barrel.js";
export const mine = 1;

// dynamic-barrel.ts
export * from "./dynamic-dep";

// dynamic-dep.ts
export const depA = 42;
```
