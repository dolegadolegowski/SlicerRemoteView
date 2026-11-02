// Stages the relay build once per run, before the workers start (stage.ts would race if each worker copied it).
import { stageRelay } from "./stage.ts";

export default function globalSetup(): void {
  stageRelay();
}
