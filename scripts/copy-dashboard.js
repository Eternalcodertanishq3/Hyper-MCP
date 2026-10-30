import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(repositoryRoot, "src", "dashboard", "public", "index.html");
const targetDirectory = path.resolve(repositoryRoot, "dist", "dashboard", "public");
if (path.relative(repositoryRoot, source).startsWith("..") || path.relative(repositoryRoot, targetDirectory).startsWith("..")) {
  throw new Error("Refusing to copy dashboard assets outside the project workspace.");
}
await mkdir(targetDirectory, { recursive: true });
await copyFile(source, path.join(targetDirectory, "index.html"));
