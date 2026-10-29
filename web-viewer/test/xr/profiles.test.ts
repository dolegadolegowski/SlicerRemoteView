import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROFILES,
  copyXrProfiles,
  sourceDir,
  targetName,
} from "../../scripts/copy-xr-profiles.mjs";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("self-hosted XR input profiles (WEB-19, NFR-09)", () => {
  it("copies the Quest controllers, the fallback and the hands, each with the GLBs its profile names", () => {
    const root = mkdtempSync(join(tmpdir(), "rv-xr-"));
    dirs.push(root);
    const dest = join(root, "xr-profiles");
    expect(copyXrProfiles(sourceDir(), dest)).toEqual(PROFILES);
    expect(PROFILES).toEqual(
      expect.arrayContaining([
        "meta-quest-touch-plus",
        "oculus-touch-v3",
        "generic-trigger",
        "generic-hand",
      ]),
    );
    for (const id of PROFILES) {
      const profile = JSON.parse(readFileSync(join(dest, id, "profile.json"), "utf8")) as {
        layouts: Record<string, { assetPath: string }>;
      };
      for (const layout of Object.values(profile.layouts))
        expect(existsSync(join(dest, id, layout.assetPath)), `${id}/${layout.assetPath}`).toBe(
          true,
        );
    }
    // The list names exactly what was copied: a listed profile without files would be fetched and fail.
    const list = JSON.parse(readFileSync(join(dest, "profilesList.json"), "utf8")) as object;
    expect(Object.keys(list)).toEqual(PROFILES);
    expect(readFileSync(join(dest, "LICENSE.md"), "utf8")).toMatch(/MIT/);
    expect(readdirSync(dest).sort()).toEqual(
      [...PROFILES, "LICENSE.md", "profilesList.json"].sort(),
    );
  });

  it("lives under /assets/ with the package version in its name (the relay's immutable cache stays right)", () => {
    expect(targetName()).toBe("xr-profiles-1.0.20");
  });
});
