/**
 * @slicerremoteview/shared — executable protocol contract.
 *
 * Source of truth: `docs/protocol.md` (v1.0). This entry point grows with the `protocol`
 * workstream (`docs/plan/protocol.md`): schema validation (PRO-06), binary chunk and
 * session-code helpers (PRO-07, below), generated message types (PRO-11).
 */

/** Protocol version every envelope carries (`docs/protocol.md` §2). */
export const PROTOCOL_VERSION = "1.0" as const;

export * from "./chunk.js";
export * from "./code.js";
