export default (EXTERNAL_PATH
  && await (await import('node:fs/promises'))
    .readFile(
      (await import('node:url'))
        .fileURLToPath(
          import.meta.resolve(EXTERNAL_PATH + '/dist/lexer.wasm')
        )
    )
)
  || (WASM_BINARY
    && (binary => 
      typeof window !== 'undefined' && typeof atob === 'function'
        ? Uint8Array.from(atob(binary), x => x.charCodeAt(0))
        : Buffer.from(binary, 'base64')
    )(WASM_BINARY)
  )
