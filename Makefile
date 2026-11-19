WASM2WAT ?= ../wabt/bin/wasm2wat
WASM2WAT_FLAGS ?= $(filter --enable-bulk-memory,$(shell $(WASM2WAT) --help))
WASM_OPT ?= ../binaryen/bin/wasm-opt

.PHONY: optimize clean

lib/lexer.wat: lib/lexer.wasm
	$(WASM2WAT) $(WASM2WAT_FLAGS) lib/lexer.wasm -o lib/lexer.wat

lib/lexer.wasm: include-wasm/cjs-module-lexer.h src/lexer.c | lib/
	node build/wasm.js --docker

lib/:
	@mkdir -p $@

optimize: lib/lexer.wasm
	$(WASM_OPT) -Oz --enable-bulk-memory lib/lexer.wasm -o lib/lexer.wasm

clean:
	$(RM) lib/*
