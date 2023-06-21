# These flags depend on the system and may be overridden
WASM_CC := ../wasi-sdk-12.0/bin/clang
WASM_CFLAGS := --sysroot=../wasi-sdk-12.0/share/wasi-sysroot
WASM_LDFLAGS := -nostartfiles

WASM2WAT := ../wabt/bin/wasm2wat
WASM_OPT := ../binaryen/bin/wasm-opt

# These are project-specific and are expected to be kept intact
WASM_EXTRA_CFLAGS := -I include-wasm/ -Wno-logical-op-parentheses -Wno-parentheses -Oz
WASM_EXTRA_LDFLAGS := -Wl,-z,stack-size=13312,--no-entry,--compress-relocations,--strip-all
WASM_EXTRA_LDFLAGS += -Wl,--export=__heap_base,--export=parseCJS,--export=sa
WASM_EXTRA_LDFLAGS += -Wl,--export=e,--export=re,--export=es,--export=ee
WASM_EXTRA_LDFLAGS += -Wl,--export=rre,--export=ree,--export=res,--export=ru,--export=us,--export=ue

.PHONY: optimize clean

lib/lexer.wat: lib/lexer.wasm
	$(WASM2WAT) lib/lexer.wasm -o lib/lexer.wat

lib/lexer.wasm: include-wasm/cjs-module-lexer.h src/lexer.c | lib/
	$(WASM_CC) $(WASM_CFLAGS) $(WASM_EXTRA_CFLAGS) \
		src/lexer.c -o lib/lexer.wasm \
		$(WASM_LDFLAGS) $(WASM_EXTRA_LDFLAGS)

lib/:
	@mkdir -p $@

optimize: lib/lexer.wasm
	$(WASM_OPT) -Oz lib/lexer.wasm -o lib/lexer.wasm

clean:
	$(RM) lib/*
