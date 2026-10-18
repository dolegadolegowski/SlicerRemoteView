export function pascalCase(messageType: string): string;
export function bundleSchemas(schemaDir: string): {
  bundle: Record<string, unknown>;
  messageNames: string[];
  typeByName: Record<string, string>;
};
