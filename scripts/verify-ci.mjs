import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const read = (name) => readFileSync(new URL("../" + name, import.meta.url), "utf8");
const version = JSON.parse(read("package.json")).version;
assert.equal(/export const PITAVERN_VERSION = "([^"]+)"/.exec(read("packages/shared/src/index.ts"))?.[1], version,
  "HTTP/WS 版本必须与发布包版本一致");

// These suites use synthetic fixtures and local mock providers only.
for (const suite of ["game", "schedules", "quests", "two-stage", "knowledge", "context", "world-engine", "chat-import", "world-templates", "world-migration", "chat-migration", "character-cards", "m4", "takeover", "m6", "regression", "compat", "models", "greetings", "chat-ux", "branches", "activity", "world-display", "rendering", "library", "regex-isolation", "library-maintenance", "card-compat", "group-script"]) {
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", `verify:${suite}`], { stdio: "inherit", shell: process.platform === "win32" });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
