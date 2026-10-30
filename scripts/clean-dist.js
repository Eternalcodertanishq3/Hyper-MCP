import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.resolve(repositoryRoot, "dist");
if (path.dirname(target) !== repositoryRoot || path.basename(target) !== "dist") {
  throw new Error("Refusing to clean an unexpected build output path: " + target);
}
await rm(target, { recursive: true, force: true });
