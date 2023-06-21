# These flags depend on the system and may be overridden
WASM_CC := ../wasi-sdk-12.0/bin/clang
WASM_CFLAGS := --sysroot=../wasi-sdk-12.0/share/wasi-sysroot
WASM_LDFLAGS := -nostartfiles

# These are project-specific and are expected to be kept intact
WASM_EXTRA_CFLAGS := -I include-wasm/ -Wno-logical-op-parentheses -Wno-parentheses -Oz
WASM_EXTRA_LDFLAGS := -Wl,-z,stack-size=13312,--no-entry,--compress-relocations,--strip-all
WASM_EXTRA_LDFLAGS += -Wl,--export=__heap_base,--export=parseCJS,--export=sa
WASM_EXTRA_LDFLAGS += -Wl,--export=e,--export=re,--export=es,--export=ee
WASM_EXTRA_LDFLAGS += -Wl,--export=rre,--export=ree,--export=res,--export=ru,--export=us,--export=ue

lslib/lexer.wat: lib/lexer.wasm
	../wabt/bin/wasm2wat lib/lexer.wasm -o lib/lexer.wat

lib/lexer.wasm: include-wasm/cjs-module-lexer.h src/lexer.c
	@mkdir -p lib
	$(WASM_CC) $(WASM_CFLAGS) $(WASM_EXTRA_CFLAGS) \
		src/lexer.c -o lib/lexer.wasm \
		$(WASM_LDFLAGS) $(WASM_EXTRA_LDFLAGS)

optimize: lib/lexer.wasm
	../binaryen/bin/wasm-opt -Oz lib/lexer.wasm -o lib/lexer.wasm

clean:
	rm lib/*
