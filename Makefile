lslib/lexer.wat: lib/lexer.wasm
	../wabt/bin/wasm2wat lib/lexer.wasm -o lib/lexer.wat

lib/lexer.wasm: include-wasm/cjs-module-lexer.h src/lexer.c
	@mkdir -p lib
	../wasi-sdk-12.0/bin/clang src/lexer.c -I include-wasm --sysroot=../wasi-sdk-12.0/share/wasi-sysroot -o lib/lexer.wasm -nostartfiles \
	-Wl,-z,stack-size=13312,--no-entry,--compress-relocations,--strip-all,--export=__heap_base,\
	--export=parseCJS,--export=sa,--export=e,--export=re,--export=es,--export=ee,--export=rre,--export=ree,--export=res,--export=ru,--export=us,--export=ue \
	-Wno-logical-op-parentheses -Wno-parentheses \
	-Oz

optimize: lib/lexer.wasm
	../binaryen/bin/wasm-opt -Oz lib/lexer.wasm -o lib/lexer.wasm

clean:
	rm lib/*
