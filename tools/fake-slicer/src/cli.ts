#!/usr/bin/env node
import { main, nodeIo } from "./run.js";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
process.exitCode = await main(process.argv.slice(2), { ...nodeIo, signal: controller.signal });
