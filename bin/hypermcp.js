#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const entry = path.join(root, "dist", "index.js");
if (!existsSync(entry)) {
  console.error("HyperMCP is not built. Run `npm run build` from the package directory first.");
  process.exitCode = 1;
} else {
  const child = spawn(process.execPath, ["--experimental-sqlite", entry, ...process.argv.slice(2)], { stdio: "inherit" });
  const forwardSignal = (signal) => child.kill(signal);
  process.once("SIGINT", forwardSignal);
  process.once("SIGTERM", forwardSignal);
  child.once("error", (error) => {
    console.error("Failed to start HyperMCP:", error.message);
    process.exitCode = 1;
  });
  child.once("close", (code, signal) => {
    process.removeListener("SIGINT", forwardSignal);
    process.removeListener("SIGTERM", forwardSignal);
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}
