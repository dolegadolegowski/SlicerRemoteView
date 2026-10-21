import { ENV_VARIABLES, PLATFORM_INPUTS } from "../../src/config.js";

/**
 * `process.env` without any relay variable, plus `overrides`: child relays started by tests must
 * not pick up a developer's or CI runner's relay settings (e.g. `LOG_LEVEL=verbose`).
 */
export function childEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [...ENV_VARIABLES, ...PLATFORM_INPUTS]) delete env[name];
  return { ...env, ...overrides };
}
