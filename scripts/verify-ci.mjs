import { spawnSync } from "node:child_process";

// These suites use synthetic fixtures and local mock providers only.
for (const suite of ["m4", "takeover", "m6", "regression", "compat", "chat-ux", "activity", "world-display", "rendering", "library", "regex-isolation", "library-maintenance"]) {
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", `verify:${suite}`], { stdio: "inherit", shell: process.platform === "win32" });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
