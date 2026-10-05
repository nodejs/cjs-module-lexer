export interface Exports {
  exports: string[];
  reexports: string[];
}

export interface ParseOptions {
  mode?: 'legacy' | 'extended';
}

export declare function parse(source: string, name?: string, options?: ParseOptions): Exports;
export declare function init(): Promise<void>;
export declare function initSync(): void;
