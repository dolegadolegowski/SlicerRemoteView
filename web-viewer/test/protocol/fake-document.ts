// `document` stand-in for the reconnect logic's `visibilitychange` (WEB-14 tests).
export class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";

  show(state: DocumentVisibilityState): void {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}
