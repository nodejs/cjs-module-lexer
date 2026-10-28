# These flags depend on the system and may be overridden
WASM_CC := clang
WASM_CFLAGS := --sysroot=/usr/share/wasi-sysroot
WASM_LDFLAGS := -nostartfiles

# These are project-specific and are expected to be kept intact
WASM_TARGET := -target wasm32-unknown-wasi
WASM_EXTRA_CFLAGS := -I include/ -Wno-logical-op-parentheses -Wno-parentheses -Oz
WASM_EXTRA_CFLAGS += -flto -mllvm -inline-threshold=150
WASM_EXTRA_LDFLAGS := -Wl,-z,stack-size=13312,--no-entry,--compress-relocations,--strip-all
WASM_EXTRA_LDFLAGS += -Wl,--mllvm=-inline-threshold=150
WASM_EXTRA_LDFLAGS += -Wl,--export=sa,--export=es,--export=ee,--export=re,--export=res,--export=ree,--export=rre,--export=us,--export=ue,--export=ru,--export=e,--export=parseCJS,--export=parseCJSWithOptions,--export=__heap_base

lib/lexer.wasm: include/cjs-module-lexer.h src/lexer-internal.h src/lexer.c src/wasm.c
	@mkdir -p lib
	$(WASM_CC) $(WASM_CFLAGS) $(WASM_TARGET) $(WASM_EXTRA_CFLAGS) \
        src/wasm.c -o lib/lexer.wasm \
        $(WASM_LDFLAGS) $(WASM_EXTRA_LDFLAGS)

optimize: lib/lexer.wasm
	${WASM_OPT} -Oz lib/lexer.wasm -o lib/lexer.wasm

clean:
	rm lib/*
