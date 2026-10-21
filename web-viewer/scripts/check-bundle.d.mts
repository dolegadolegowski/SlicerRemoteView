// Types for scripts/check-bundle.mjs (imported by test/bundle.test.ts).
export declare const BUDGET_BYTES: number;
export declare function initialAssets(html: string): string[];
export declare function measure(
  dist: string,
): { readonly url: string; readonly bytes: number; readonly gzip: number }[];
