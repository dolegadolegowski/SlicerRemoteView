import { describe, expect, it } from "vitest";
import { LIMITS } from "@slicerremoteview/shared";
import { currentDevice, detectDevice, snapshotLimit } from "../src/platform";

// User agents from docs/research/web-quest-user-agent.md (§1.2, §2, §5), verbatim, and Playwright's device list.
// `quest2Legacy` and `standaloneHmd` are synthetic: the platform parts of research §1.3 on a Quest Browser UA.
const UA = {
  iPhone15:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Mobile/15E148 Safari/604.1",
  pixel7:
    "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.96 Mobile Safari/537.36",
  desktopChrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.96 Safari/537.36",
  wolvic: "Mozilla/5.0 (Android 10; Mobile VR; rv:105.0) Gecko/105.0 Firefox/105.0 Wolvic/1.3",
  yandexOnQuest3S:
    "Mozilla/5.0 (Linux; arm_64; Android 14; Quest 3S) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6998.111 YaBrowser/25.4.4.111.01 Safari/537.36",
  pico4:
    "Mozilla/5.0 (X11; Linux x86_64; PICO 4 OS5.4.0 like Quest) AppleWebKit/537.36 (KHTML, like Gecko) PicoBrowser/3.3.22 Chrome/105.0.5195.68 VR Safari/537.36 OculusBrowser/7.0",
  picoNeo3Mobile:
    "Mozilla/5.0 (Linux; Android 10; Pico Neo 3 OS5.9.5.0 like Quest) AppleWebKit/537.36 (KHTML, like Gecko) PicoBrowser/3.3.36 Chrome/105.0.5195.68 Mobile VR Safari/537.36  OculusBrowser/7.0",
  quest3:
    "Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/39.2.0.0.56.754450099 Chrome/136.0.7103.177 VR Safari/537.36",
  quest2:
    "Mozilla/5.0 (X11; Linux x86_64; Quest 2) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/18.1.0.2.46.337441587 SamsungBrowser/4.0 Chrome/95.0.4638.74 VR Safari/537.36",
  quest2Legacy:
    "Mozilla/5.0 (Linux; Android 10; Quest 2) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/15.0.0.0.22.280317669 SamsungBrowser/4.0 Chrome/89.0.4389.90 VR Safari/537.36",
  questPro:
    "Mozilla/5.0 (X11; Linux x86_64; Quest Pro) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/32.1.0.37.133.575621010 Chrome/122.0.6261.64 VR Safari/537.36",
  quest1:
    "Mozilla/5.0 (X11; Linux x86_64; Quest) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/26.2.0.0.10 SamsungBrowser/4.0 Chrome/110.0.5481.192 VR Safari/537.36",
  iwerQuest1:
    "Mozilla/5.0 (X11; Linux x86_64; Quest 1) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/33.0.0.0.0.0 Chrome/126.0.6478.122 VR Safari/537.36",
  standaloneHmd:
    "Mozilla/5.0 (Linux; Android 10; Standalone HMD) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/12.0.0.4.59.255185937 SamsungBrowser/4.0 Chrome/85.0.4183.127 VR Safari/537.36",
};

const quest3Variant = (from: string, to: string) => UA.quest3.replace(from, to);

describe("detectDevice (FR-49, protocol §5.1)", () => {
  it.each([
    ["iPhone 15", UA.iPhone15],
    ["Pixel 7", UA.pixel7],
    ["desktop Chrome", UA.desktopChrome],
    ["Wolvic (no Quest Browser token)", UA.wolvic],
    ["another browser on a Quest 3S", UA.yandexOnQuest3S],
    ["Pico 4 (spoofs Quest)", UA.pico4],
    ["Pico Neo 3, mobile mode", UA.picoNeo3Mobile],
    ["an empty user agent", ""],
  ])("%s → web / mobile", (_label, ua) => {
    expect(detectDevice(ua)).toEqual({ platform: "web", profile: "mobile" });
  });

  it.each([
    ["Quest 3 (Meta's example; Quest 3S sends the same token)", UA.quest3],
    ["Quest 3 in mobile mode", quest3Variant(" VR Safari", " Mobile VR Safari")],
    [
      "Quest 3 with an Android platform part",
      quest3Variant("X11; Linux x86_64; Quest 3", "Linux; Android 12; Quest 3"),
    ],
    ["a Quest 3S token, should Meta send one", quest3Variant("Quest 3)", "Quest 3S)")],
  ])("%s → quest-browser / quest3", (_label, ua) => {
    expect(detectDevice(ua)).toEqual({ platform: "quest-browser", profile: "quest3" });
  });

  it.each([
    ["Quest 2", UA.quest2],
    ["Quest 2, legacy Android platform part", UA.quest2Legacy],
    ["Quest Pro (Meta groups it with Quest 2)", UA.questPro],
    ["Quest (1)", UA.quest1],
    ["Quest 1 (IWER)", UA.iwerQuest1],
    ["Standalone HMD (early Quest 2 firmware)", UA.standaloneHmd],
    ["no device token", quest3Variant("X11; Linux x86_64; Quest 3", "X11; Linux x86_64")],
    ["a model Meta does not list yet", quest3Variant("Quest 3)", "Quest 4)")],
  ])("%s → quest-browser / quest2", (_label, ua) => {
    expect(detectDevice(ua)).toEqual({ platform: "quest-browser", profile: "quest2" });
  });

  it("currentDevice reads navigator.userAgent", () => {
    expect(currentDevice({ userAgent: UA.quest3 })).toEqual({
      platform: "quest-browser",
      profile: "quest3",
    });
    expect(currentDevice({ userAgent: UA.pixel7 })).toEqual({ platform: "web", profile: "mobile" });
  });

  it("the snapshot limit follows the profile: 64 MiB for quest3, 32 MiB otherwise (§7.5)", () => {
    expect(snapshotLimit("quest3")).toBe(LIMITS.MAX_SNAPSHOT_BYTES);
    expect(snapshotLimit("quest3")).toBe(64 * 1024 * 1024);
    expect(snapshotLimit("quest2")).toBe(32 * 1024 * 1024);
    expect(snapshotLimit("mobile")).toBe(32 * 1024 * 1024);
  });
});
