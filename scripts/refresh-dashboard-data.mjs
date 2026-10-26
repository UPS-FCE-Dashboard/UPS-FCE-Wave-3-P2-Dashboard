/**
 * End-to-end refresh: fetch Jira → build tab JSON snapshots.
 */
import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function run(script) {
  console.log(`\n=== ${script} ===`);
  const r = spawnSync(process.execPath, [path.join(__dirname, script)], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  if (r.status !== 0) process.exit(r.status || 1);
}

run("fetch-jira-raw.mjs");
run("build-tab-snapshots.mjs");
run("build-p2-testing.mjs");
console.log("\nDashboard data refresh complete.");
