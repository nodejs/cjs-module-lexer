export interface Exports {
  exports: string[];
  /** Alternative final values; each group contains dependencies combined in one value. */
  reexports: string[][];
  /** Present when competing replacements are analyzed. False for unsupported effects, filtered names, or limits. */
  complete?: boolean;
}

export interface LegacyExports {
  exports: string[];
  reexports: string[];
}

export interface ParseOptions {
  baseline?: 'legacy' | 'flow-v1';
}

export declare function parse(source: string, name: string | undefined, options: { baseline: 'legacy' }): LegacyExports;
export declare function parse(source: string, name: string | undefined, options: { baseline?: 'flow-v1' }): Exports;
export declare function parse(source: string, name: string | undefined, options: ParseOptions): Exports | LegacyExports;
export declare function parse(source: string, name?: string): Exports;
export declare function init(): Promise<void>;
export declare function initSync(): void;
