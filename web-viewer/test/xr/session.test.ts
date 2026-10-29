import { describe, expect, it, vi } from "vitest";
import {
  EventDispatcher,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Texture,
  TextureLoader,
  Vector3,
} from "three";
import { XRControllerModelFactory } from "three/addons/webxr/XRControllerModelFactory.js";
import { XRHandModelFactory } from "three/addons/webxr/XRHandModelFactory.js";
import { targetName } from "../../scripts/copy-xr-profiles.mjs";
import type { XrHost } from "../../src/render/viewer";
import {
  DOUBLE_PRESS_MS,
  imageTextureGltfLoader,
  runXrSession,
  WARNING_MS,
  XR_PROFILES_PATH,
} from "../../src/xr/session";
import { XR_PANEL_DISTANCE_M, XR_PANEL_DROP_M } from "../../src/xr/placement";

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
    getController: (i: number) => group(`ray${i}`),
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
  let stage = new Matrix4();
  const host = {
    renderer,
    scene: new Scene(),
    camera: new PerspectiveCamera(),
    begin: vi.fn(),
    place: vi.fn(),
    end: vi.fn(),
    stageMatrix: () => stage.clone(),
    setStageMatrix: vi.fn((m: Matrix4) => void (stage = m.clone())),
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
    expect(fake.scene.children).toHaveLength(5); // two grips, two hands, the text panels' column
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
    for (const [name, group] of groups)
      if (!name.startsWith("ray")) expect(group.children, name).toHaveLength(1);
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

  describe("grabbing (WEB-20)", () => {
    const at = (x: number, y: number, z: number) => new Matrix4().makeTranslation(x, y, z);

    it("a press (trigger or pinch) grabs: the scene follows that hand until it lets go", async () => {
      const { host, fake, groups, frame } = fakeHost();
      await runXrSession(host, fakeSession() as unknown as XRSession, "immersive-vr");
      const ray = groups.get("ray1")!;
      ray.matrix.copy(at(0.2, 1.2, -0.4));
      ray.dispatchEvent({ type: "selectstart" } as never);
      frame(frameAt(1.5)); // the frame after the press anchors the hand
      ray.matrix.copy(at(0.3, 1.2, -0.4)); // 10 cm to the right
      frame(frameAt(1.5));
      const moved = fake.setStageMatrix.mock.calls.at(-1)![0];
      expect(moved.elements[12]).toBeCloseTo(0.1, 9);
      ray.dispatchEvent({ type: "selectend" } as never);
      fake.setStageMatrix.mockClear();
      ray.matrix.copy(at(1, 1, 1));
      frame(frameAt(1.5));
      expect(fake.setStageMatrix).not.toHaveBeenCalled(); // let go: the scene stays
    });

    it("the grip button, or two quick presses, put the scene back in front at the eye height", async () => {
      vi.useFakeTimers();
      try {
        const { host, fake, groups, frame } = fakeHost();
        await runXrSession(host, fakeSession() as unknown as XRSession, "immersive-vr");
        frame(frameAt(1.62));
        fake.place.mockClear();
        groups.get("ray0")!.dispatchEvent({ type: "squeezestart" } as never);
        expect(fake.place).toHaveBeenLastCalledWith(1.62);
        fake.place.mockClear();
        const ray = groups.get("ray1")!;
        ray.dispatchEvent({ type: "selectstart" } as never);
        ray.dispatchEvent({ type: "selectend" } as never);
        vi.advanceTimersByTime(DOUBLE_PRESS_MS + 1);
        ray.dispatchEvent({ type: "selectstart" } as never); // too late for a double press: a grab
        expect(fake.place).not.toHaveBeenCalled();
        ray.dispatchEvent({ type: "selectend" } as never);
        groups.get("ray0")!.dispatchEvent({ type: "selectstart" } as never); // the other hand: a two-hand grab
        expect(fake.place).not.toHaveBeenCalled();
        ray.dispatchEvent({ type: "selectstart" } as never); // the same hand again: reset
        expect(fake.place).toHaveBeenLastCalledWith(1.62);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a hand drags with its wrist (rigid to the hand), not its aim ray", async () => {
      const { host, fake, groups, frame } = fakeHost();
      await runXrSession(host, fakeSession() as unknown as XRSession, "immersive-vr");
      const ray = groups.get("ray0")!;
      const wrist = new Group();
      Object.assign(groups.get("hand0")!, { joints: { wrist } });
      ray.dispatchEvent({ type: "connected", data: { hand: {} } } as never);
      wrist.matrix.copy(at(0.1, 1.1, -0.3));
      ray.matrix.copy(at(5, 5, 5)); // the aim ray goes elsewhere: ignored
      ray.dispatchEvent({ type: "selectstart" } as never); // a pinch
      frame(frameAt(1.5));
      wrist.matrix.copy(at(0.1, 1.3, -0.3)); // the wrist rises 20 cm
      frame(frameAt(1.5));
      expect(fake.setStageMatrix.mock.calls.at(-1)![0].elements[13]).toBeCloseTo(0.2, 9);
      wrist.visible = false; // the hand out of view: the scene stays
      fake.setStageMatrix.mockClear();
      frame(frameAt(1.5));
      expect(fake.setStageMatrix).not.toHaveBeenCalled();
    });

    it("the second press of a double press only resets: moving before letting go does not drag", async () => {
      const { host, fake, groups, frame } = fakeHost();
      await runXrSession(host, fakeSession() as unknown as XRSession, "immersive-vr");
      const ray = groups.get("ray0")!;
      ray.dispatchEvent({ type: "selectstart" } as never);
      ray.dispatchEvent({ type: "selectend" } as never);
      ray.dispatchEvent({ type: "selectstart" } as never); // within DOUBLE_PRESS_MS: reset
      fake.setStageMatrix.mockClear();
      ray.matrix.copy(at(0.3, 1.2, -0.4));
      frame(frameAt(1.5));
      expect(fake.setStageMatrix).not.toHaveBeenCalled();
    });

    it("an input that disconnects lets go", async () => {
      const { host, fake, groups, frame } = fakeHost();
      await runXrSession(host, fakeSession() as unknown as XRSession, "immersive-vr");
      const ray = groups.get("ray1")!;
      ray.dispatchEvent({ type: "selectstart" } as never);
      ray.dispatchEvent({ type: "disconnected" } as never);
      fake.setStageMatrix.mockClear();
      ray.matrix.copy(at(0.3, 1.2, -0.4)); // a new source in the same slot
      frame(frameAt(1.5));
      expect(fake.setStageMatrix).not.toHaveBeenCalled();
    });

    it("presses after the session are not heard", async () => {
      const { host, fake, groups, sessionEnd } = fakeHost();
      await runXrSession(host, fakeSession() as unknown as XRSession, "immersive-vr");
      sessionEnd();
      fake.place.mockClear();
      groups.get("ray0")!.dispatchEvent({ type: "squeezestart" } as never);
      expect(fake.place).not.toHaveBeenCalled();
    });
  });

  /** Panels of `height` metres, recorded with their text; `freed` once its geometry, texture and material are. */
  const panels = (height = 0.1) => {
    const made: { text: string; mesh: Mesh; freed: () => boolean }[] = [];
    const make = vi.fn((text: string) => {
      const material = new MeshBasicMaterial({ map: new Texture() });
      const mesh = new Mesh(new PlaneGeometry(0.6, height), material);
      const spies = [
        vi.spyOn(mesh.geometry, "dispose"),
        vi.spyOn(material, "dispose"),
        vi.spyOn(material.map!, "dispose"),
      ];
      made.push({ text, mesh, freed: () => spies.every((spy) => spy.mock.calls.length === 1) });
      return mesh;
    });
    return { make, made };
  };
  const world = (mesh: Mesh) => mesh.getWorldPosition(new Vector3());

  it("a warning stands below the scene once it is placed, facing the eyes, for WARNING_MS (the Quest 2 budget, WEB-20)", async () => {
    vi.useFakeTimers();
    try {
      const { host, fake, frame } = fakeHost();
      const { make, made } = panels(0.2);
      await runXrSession(host, fakeSession() as unknown as XRSession, "immersive-vr", {
        warning: "Above the Quest 2 budget",
        panel: make,
      });
      frame(frameAt(null));
      expect(make).not.toHaveBeenCalled(); // not before the scene has its place
      frame(frameAt(1.6));
      expect(make).toHaveBeenCalledWith("Above the Quest 2 budget");
      const panel = made[0]!.mesh;
      expect(panel.parent?.parent).toBe(fake.scene);
      // Its top edge 0.3 m below the eyes, 0.9 m ahead; its centre half its height down the tilted column.
      const tilt = Math.atan2(XR_PANEL_DROP_M, XR_PANEL_DISTANCE_M);
      const at = world(panel);
      expect(at.y).toBeCloseTo(1.6 - XR_PANEL_DROP_M - 0.1 * Math.cos(tilt), 9);
      expect(at.z).toBeCloseTo(-XR_PANEL_DISTANCE_M + 0.1 * Math.sin(tilt), 9);
      // The column faces the eyes of the user where they stood, its panels with it.
      const facing = new Vector3(0, 0, 1).transformDirection(panel.matrixWorld);
      const toEyes = new Vector3(0, 1.6, 0)
        .sub(panel.parent!.getWorldPosition(new Vector3()))
        .normalize();
      expect(facing.dot(toEyes)).toBeGreaterThan(0.999);
      vi.advanceTimersByTime(WARNING_MS);
      expect(panel.parent).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  describe("status line (WEB-23)", () => {
    it("follows `status` once the scene is placed: drawn anew only when it changes, gone when nothing is to say", async () => {
      const { host, frame } = fakeHost();
      const { make, made } = panels();
      let said: string | null = "Reconnecting…";
      await runXrSession(host, fakeSession() as unknown as XRSession, "immersive-vr", {
        panel: make,
        status: () => said,
      });
      frame(frameAt(null));
      expect(make).not.toHaveBeenCalled(); // not before the scene has its place
      frame(frameAt(1.6));
      frame(frameAt(1.6));
      expect(made.map((m) => m.text)).toEqual(["Reconnecting…"]); // once, not every frame
      const first = made[0]!.mesh;
      expect(first.parent).not.toBeNull();
      said = "Reconnecting…\nUpdating the scene…";
      frame(frameAt(1.6));
      expect(first.parent).toBeNull(); // replaced
      expect(made.at(-1)!.text).toBe("Reconnecting…\nUpdating the scene…");
      // Freed a frame later, once the new panel has been drawn (three keeps the shader program for it).
      expect(made[0]!.freed()).toBe(false);
      frame(frameAt(1.6));
      expect(made[0]!.freed()).toBe(true);
      said = null;
      frame(frameAt(1.6));
      expect(made.at(-1)!.mesh.parent).toBeNull();
      frame(frameAt(1.6));
      expect(made.at(-1)!.freed()).toBe(true);
      expect(make).toHaveBeenCalledTimes(2);
    });

    it("stands under the warning while it is up and takes its place after; a reset brings it back below the scene", async () => {
      vi.useFakeTimers();
      try {
        const { host, groups, frame } = fakeHost();
        const { make, made } = panels(0.1);
        await runXrSession(host, fakeSession() as unknown as XRSession, "immersive-vr", {
          warning: "Not prepared for Quest 2",
          panel: make,
          status: () => "Presenter is offline",
        });
        frame(frameAt(1.6));
        const [warning, status] = made.map((m) => m.mesh) as [Mesh, Mesh];
        expect(warning.position.y).toBeCloseTo(-0.05, 9); // in the column: its top at the top
        expect(status.position.y).toBeCloseTo(-0.17, 9); // under it, 2 cm apart
        vi.advanceTimersByTime(WARNING_MS);
        frame(frameAt(1.6));
        expect(status.position.y).toBeCloseTo(-0.05, 9);
        const before = world(status);
        frame(frameAt(1.8)); // the user stood up: the panels stay where they were put
        expect(world(status).distanceTo(before)).toBeLessThan(1e-9);
        groups.get("ray0")!.dispatchEvent({ type: "squeezestart" } as never); // reset
        expect(world(status).y - before.y).toBeCloseTo(0.2, 2); // in front of the eyes again
      } finally {
        vi.useRealTimers();
      }
    });

    it("the end of the session takes the panels away and frees them, a replaced one too", async () => {
      const { host, fake, frame, sessionEnd } = fakeHost();
      const { make, made } = panels();
      let said = "Reconnecting…";
      await runXrSession(host, fakeSession() as unknown as XRSession, "immersive-vr", {
        warning: "Not prepared for Quest 2",
        panel: make,
        status: () => said,
      });
      frame(frameAt(1.6));
      said = "Presenter is offline";
      frame(frameAt(1.6)); // the first status panel waits to be freed
      sessionEnd();
      expect(made).toHaveLength(3);
      for (const { mesh, freed } of made) {
        expect(mesh.parent).toBeNull();
        expect(freed()).toBe(true);
      }
      expect(fake.scene.children).toHaveLength(0);
    });
  });

  it("no warning, no panel", async () => {
    const { host, frame } = fakeHost();
    const make = vi.fn(() => new Mesh());
    await runXrSession(host, fakeSession() as unknown as XRSession, "immersive-vr", {
      panel: make,
    });
    frame(frameAt(1.6));
    expect(make).not.toHaveBeenCalled();
  });
});
