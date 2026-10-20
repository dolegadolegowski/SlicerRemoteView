import { readFileSync } from "node:fs";

const MESSAGES = new URL("../../../shared/fixtures/messages/", import.meta.url);

/**
 * The message of `shared/fixtures/messages/<type>/<name>.json` (PRO-04/05/18/19). Invalid fixtures
 * wrap it as `{ $comment, expect, message }`; valid ones are the message itself.
 */
export function fixture(type: string, name = "valid-example"): Record<string, unknown> {
  const data = JSON.parse(
    readFileSync(new URL(`${type}/${name}.json`, MESSAGES), "utf8"),
  ) as Record<string, unknown>;
  return "expect" in data && "message" in data ? (data.message as Record<string, unknown>) : data;
}
