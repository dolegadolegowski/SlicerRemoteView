export const CS_OUT_DIR: string;
export function renderCs(schemaDir?: string): Promise<Map<string, string>>;
export function syncCs(options?: {
  check?: boolean;
  outDir?: string;
  schemaDir?: string;
}): Promise<string[]>;
