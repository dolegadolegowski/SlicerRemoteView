import { describe, expect, it, vi } from "vitest";
import { EventDispatcher, Group, PerspectiveCamera, Scene, TextureLoader } from "three";
import { XRControllerModelFactory } from "three/addons/webxr/XRControllerModelFactory.js";
import { XRHandModelFactory } from "three/addons/webxr/XRHandModelFactory.js";
import { targetName } from "../../scripts/copy-xr-profiles.mjs";
import type { XrHost } from "../../src/render/viewer";
import { imageTextureGltfLoader, runXrSession, XR_PROFILES_PATH } from "../../src/xr/session";

type Loop = ((time: number, frame?: XRFrame) => void) | null;

/** A viewer's XR side with a renderer that records what the session does to it. */
function fakeHost(setSession: () => Promise<void> = async () => {}) {
  const groups = new Map<string, Group>();
  const group = (name: string) => groups.get(name) ?? groups.set(name, new Group()).get(name)!;
  let loop: Loop = null;
  // three's WebXRManager is an EventDispatcher: `sessionend` comes from it, after its own restore.
  const xr = Object.assign(new EventDispatcher<{ sessionend: object }>(), {
    enabled: false,
    setReferenceSpaceType: vi.fn(),
    getControllerGrip: (i: number) => group(`grip${i}`),
    getHand: (i: number) => group(`hand${i}`),
    getReferenceSpace: vi.fn(() => ({}) as XRReferenceSpace),
    setSession: vi.fn(setSession),
  });
  const sessionEnd = () => xr.dispatchEvent({ type: "sessionend" });
  const renderer = {
    xr,
    render: vi.fn(),
    setAnimationLoop: vi.fn((fn: Loop) => void (loop = fn)),
  };
  const host = {
    renderer,
    scene: new Scene(),
    camera: new PerspectiveCamera(),
    begin: vi.fn(),
    place: vi.fn(),
    end: vi.fn(),
  };
  return {
    host: host as unknown as XrHost,
    fake: host,
    xr,
    renderer,
    groups,
    sessionEnd,
    frame: (f?: XRFrame) => loop?.(0, f),
  };
}

function fakeSession() {
  return Object.assign(new EventTarget(), {
    end: vi.fn(async function (this: EventTarget) {
      this.dispatchEvent(new Event("end"));
    }),
  });
}

/** An `XRFrame` whose viewer pose is at `y` metres (`null`: tracking not ready). */
const frameAt = (y: number | null) =>
  ({
    getViewerPose: () => (y === null ? null : { transform: { position: { y } } }),
  }) as unknown as XRFrame;

describe("an XR session (WEB-19)", () => {
  it("starts in local-floor space, hands the drawing to WebXR and adds both controllers and hands", async () => {
    const controllerPath = vi.spyOn(XRControllerModelFactory.prototype, "setPath");
    const handPath = vi.spyOn(XRHandModelFactory.prototype, "setPath");
    const { host, fake, xr, renderer } = fakeHost();
    const session = fakeSession();
    await runXrSession(host, session as unknown as XRSession, "immersive-ar");
    expect(xr.enabled).toBe(true);
    expect(xr.setReferenceSpaceType).toHaveBeenCalledWith("local-floor");
    expect(fake.begin).toHaveBeenCalledWith({ ar: true });
    expect(xr.setSession).toHaveBeenCalledWith(session);
    expect(renderer.setAnimationLoop).toHaveBeenCalledWith(expect.any(Function));
    expect(fake.scene.children).toHaveLength(4); // two grips, two hands
    // Self-hosted models only (never the jsDelivr default).
    expect(controllerPath).toHaveBeenCalledWith(XR_PROFILES_PATH);
    expect(handPath).toHaveBeenCalledWith(`${XR_PROFILES_PATH}/generic-hand/`);
    expect(XR_PROFILES_PATH).toBe(`/assets/${targetName()}`); // where the build copies them
    controllerPath.mockRestore();
    handPath.mockRestore();
  });

  it("VR keeps the room dark", async () => {
    const { host, fake } = fakeHost();
    await runXrSession(host, fakeSession() as unknown as XRSession, "immersive-vr");
    expect(fake.begin).toHaveBeenCalledWith({ ar: false });
  });

  it("places the scene at the default height until the headset reports a pose, then once for good", async () => {
    const { host, fake, renderer, frame } = fakeHost();
    await runXrSession(host, fakeSession() as unknown as XRSession, "immersive-vr");
    frame(frameAt(null));
    expect(fake.place).toHaveBeenLastCalledWith(Number.NaN); // placement.ts: the default eye height
    frame(frameAt(1.55));
    expect(fake.place).toHaveBeenLastCalledWith(1.55);
    frame(frameAt(1.7)); // the user moves: the scene stays where it was put
    expect(fake.place).toHaveBeenCalledTimes(2);
    expect(renderer.render).toHaveBeenCalledTimes(3); // every frame
  });

  it("the end of the session, however it ends, brings the 2D view back once, after three's own restore", async () => {
    const { host, fake, xr, renderer, sessionEnd } = fakeHost();
    const session = fakeSession();
    const onEnd = vi.fn();
    await runXrSession(host, session as unknown as XRSession, "immersive-ar", { onEnd });
    // The session's own `end` comes before three has put back fov, zoom, size and the render target: not yet.
    session.dispatchEvent(new Event("end"));
    expect(fake.end).not.toHaveBeenCalled();
    sessionEnd(); // three's `sessionend`, e.g. after the headset's menu
    sessionEnd();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(renderer.setAnimationLoop).toHaveBeenLastCalledWith(null);
    expect(fake.scene.children).toHaveLength(0);
    expect(xr.enabled).toBe(false);
    expect(fake.end).toHaveBeenCalledTimes(1);
  });

  it("a session WebXR refuses brings the 2D view back, is ended and rejects", async () => {
    const { host, fake } = fakeHost(() => Promise.reject(new Error("NotSupportedError")));
    const session = fakeSession();
    await expect(
      runXrSession(host, session as unknown as XRSession, "immersive-vr"),
    ).rejects.toThrow("NotSupportedError");
    expect(fake.end).toHaveBeenCalledTimes(1);
    expect(session.end).toHaveBeenCalled();
  });

  it("a second session on the same viewer reuses the input models (no second set of listeners)", async () => {
    const { host, groups, sessionEnd } = fakeHost();
    await runXrSession(host, fakeSession() as unknown as XRSession, "immersive-vr");
    sessionEnd();
    await runXrSession(host, fakeSession() as unknown as XRSession, "immersive-vr");
    for (const group of groups.values()) expect(group.children).toHaveLength(1);
  });

  it("the models' textures load as images (TextureLoader), which the relay's CSP allows", () => {
    const loader = imageTextureGltfLoader() as unknown as {
      pluginCallbacks: ((parser: object) => { name: string })[];
    };
    const parser = { options: { manager: undefined }, textureLoader: null as unknown };
    const plugin = loader.pluginCallbacks.at(-1)!(parser);
    expect(plugin.name).toBeTruthy();
    expect(parser.textureLoader).toBeInstanceOf(TextureLoader);
  });
});
