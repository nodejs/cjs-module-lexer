export interface Exports {
  exports: string[];
  reexports: string[];
}

export interface ParseOptions {
  baseline?: 'legacy' | 'flow-v1';
}

export interface FlowCondition {
  start: number;
  end: number;
  when: 'truthy' | 'falsy' | 'nullish' | 'non-nullish';
}

export type FlowExportValue =
  | { kind: 'module'; specifier: string }
  | { kind: 'object'; properties: string[] }
  | { kind: 'literal'; value: string | number | boolean | null | undefined }
  | { kind: 'unknown'; reason: string; start?: number; end?: number };

export interface ExportAnalysis {
  baseline: 'flow-v1';
  complete: boolean;
  outcomes: { conditions: FlowCondition[]; value: FlowExportValue }[];
}

export declare function parse(source: string, name: string | undefined, options: { baseline: 'flow-v1' }): ExportAnalysis;
export declare function parse(source: string, name: string | undefined, options: { baseline?: 'legacy' }): Exports;
export declare function parse(source: string, name: string | undefined, options: ParseOptions): Exports | ExportAnalysis;
export declare function parse(source: string, name?: string): Exports;
export declare function init(): Promise<void>;
export declare function initSync(): void;
