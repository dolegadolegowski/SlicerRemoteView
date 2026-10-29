// Component smoke (WEB-10; US-07, US-08, NFR-12, NFR-15, NFR-39): a real publisher — the fake-slicer CLI — publishes
// asymmetric-2nodes.glb through the relay stub of tools/fake-slicer (`[stub: SRV-22]`); the viewer joins with the code
// as a user types it, renders the scene and lists both nodes. The code comes from the CLI's fd 3 and must appear in
// no URL, no request, no frame but `viewer.join`, and nowhere in the CLI's output.

import { expect, test } from "@playwright/test";
import { footprint, settled } from "./canvas";
import { bridge, startPublisher } from "./fake-slicer";

test("a viewer joins a fake-slicer session with its code, renders the scene and lists both nodes", async ({
  page,
}) => {
  const urls: string[] = [];
  page.on("request", (request) => urls.push(request.url()));
  page.on("framenavigated", (frame) => urls.push(frame.url()));
  const publisher = await startPublisher();
  try {
    const traffic = await bridge(page, publisher.stub);
    await page.goto("/");
    const webgl2 = await page.evaluate(
      () => !!document.createElement("canvas").getContext("webgl2"),
    );
    test.skip(!webgl2, "no WebGL 2 in this headless browser, so the viewer cannot open");

    await page.locator(".code-entry__cell").first().click();
    await page.keyboard.type(publisher.code.toLowerCase()); // a phone keyboard may type lower case
    await page.locator(".code-entry__join").click();

    await expect(page.locator(".viewer[data-model='loaded']")).toBeVisible({ timeout: 20_000 });
    expect((await footprint(page, await settled(page))).area).toBeGreaterThan(0.01); // the model is drawn
    await page.locator(".node-panel__toggle").click();
    await expect(page.locator(".node-panel__row")).toHaveText(["Liver", "Tumor"]);

    const code = new RegExp(publisher.code, "i");
    urls.push(page.url(), ...traffic.urls);
    expect(traffic.urls).toEqual([expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+\/ws$/)]);
    expect(urls.filter((url) => code.test(url))).toEqual([]);
    expect(traffic.sent.filter((frame) => code.test(frame)).map((f) => JSON.parse(f).type)).toEqual(
      ["viewer.join"],
    );
    expect(publisher.output()).not.toMatch(code);
  } finally {
    await publisher.close();
  }
});
