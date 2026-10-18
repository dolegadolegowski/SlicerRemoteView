/**
 * @slicerremoteview/shared — executable protocol contract.
 *
 * Source of truth: `docs/protocol.md` (v1.0). Browser-safe (no `node:` imports): schema
 * validation (`validate.ts`, PRO-06), permissions matrix (`permissions.ts`), constants
 * (`constants.ts`), binary chunk and session-code helpers (`chunk.ts`, `code.ts`, PRO-07);
 * generated message types arrive with PRO-11 (`generated/messages.ts`).
 */

export * from "./validate.js";
export * from "./permissions.js";
export * from "./constants.js";
export * from "./chunk.js";
export * from "./code.js";
