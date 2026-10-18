/** Minimal typings for the Khronos `gltf-validator` npm package (Dart compiled to JS, CommonJS). */
declare module "gltf-validator" {
  export interface ValidationMessage {
    code: string;
    message: string;
    /** 0 error, 1 warning, 2 information, 3 hint. */
    severity: 0 | 1 | 2 | 3;
    pointer?: string;
  }
  export interface ValidationReport {
    validatorVersion: string;
    issues: {
      numErrors: number;
      numWarnings: number;
      numInfos: number;
      numHints: number;
      messages: ValidationMessage[];
    };
    info?: Record<string, unknown>;
  }
  export interface ValidationOptions {
    uri?: string;
    format?: "glb" | "gltf";
    writeTimestamp?: boolean;
    maxIssues?: number;
    ignoredIssues?: string[];
    onlyIssues?: string[];
    severityOverrides?: Record<string, 0 | 1 | 2 | 3>;
    externalResourceFunction?: (uri: string) => Promise<Uint8Array>;
  }
  export function version(): string;
  export function supportedExtensions(): string[];
  export function validateBytes(
    data: Uint8Array,
    options?: ValidationOptions,
  ): Promise<ValidationReport>;
  export function validateString(
    json: string,
    options?: ValidationOptions,
  ): Promise<ValidationReport>;
}
