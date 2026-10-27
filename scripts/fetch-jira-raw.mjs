/**
 * Pull live Jira issues into data/_raw for the dashboard builders.
 *
 * Requires env: JIRA_EMAIL, JIRA_API_TOKEN
 * Optional: JIRA_BASE_URL (default PwC site)
 */
import path from "path";
import { fileURLToPath } from "url";
import { searchJql, writeRaw, chunk } from "./lib/jira.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAW = path.resolve(__dirname, "..", "data", "_raw");

const PROJECT = "CONAMER1001932";

const JQL = {
  conversionParents: `project = ${PROJECT} AND issuetype = "Conversion Execution" AND component = "Release 1" AND "Test Cycle" = P2 AND fixVersion = "Wave 3" AND status != Withdrawn ORDER BY key ASC`,
  conversionDefects: `project = ${PROJECT} AND issuetype = Defect AND labels = conversion AND status not in (Resolved, Withdrawn, Closed, Done, Completed) AND (fixVersion = "Wave 3" OR (component = "Release 1" AND "Test Cycle" = P2)) ORDER BY key ASC`,
  prep: `project = ${PROJECT} AND labels = P2-Prep ORDER BY key ASC`,
  riceParents: `project = ${PROJECT} AND component = "Release 1" AND "Test Cycle" = P2 AND fixVersion = "Wave 3" AND status != Withdrawn AND issuetype in (Integration, Extension, Report, Conversion) ORDER BY key ASC`,
  testExecutions: `project = ${PROJECT} AND issuetype = "Test Execution" AND "Test Cycle" = P2 AND (labels is EMPTY OR labels != conversion) ORDER BY key ASC`,
  testDefects: `project = ${PROJECT} AND issuetype = Defect AND "Test Cycle" = P2 AND (labels is EMPTY OR labels != conversion) ORDER BY key ASC`,
};

async function fetchSubsForParents(parents, label) {
  const keys = parents.map((p) => p.key);
  const all = [];
  for (const batch of chunk(keys, 40)) {
    const jql = `project = ${PROJECT} AND parent in (${batch.join(", ")}) ORDER BY key ASC`;
    const issues = await searchJql(jql);
    all.push(...issues);
    console.log(`  ${label} batch +${issues.length} (total ${all.length})`);
  }
  return all;
}

function collectLinkedCrKeys(riceParents) {
  const keys = new Set();
  for (const p of riceParents) {
    for (const link of p.fields?.issuelinks || []) {
      for (const side of [link.outwardIssue, link.inwardIssue]) {
        if (side?.fields?.issuetype?.name === "Change Request" && side.key) {
          keys.add(side.key);
        } else if (side?.key && /Change Request/i.test(side.fields?.issuetype?.name || "")) {
          keys.add(side.key);
        } else if (side?.key && !side.fields?.issuetype) {
          // type may be missing on compact links — still collect, filter after fetch
          keys.add(side.key);
        }
      }
    }
  }
  return [...keys];
}

async function main() {
  console.log("Fetching Conversion Execution parents…");
  const conversionParents = await searchJql(JQL.conversionParents);
  writeRaw(path.join(RAW, "conversion-parents.json"), conversionParents);

  console.log("Fetching Conversion subtasks…");
  const conversionSubs = await fetchSubsForParents(conversionParents, "conversion-subs");
  writeRaw(path.join(RAW, "conversion-subtasks.json"), conversionSubs);
  // Clear optional second page file so the builder does not mix stale dumps.
  writeRaw(path.join(RAW, "conversion-subtasks-p2.json"), []);

  console.log("Fetching Conversion defects…");
  const conversionDefects = await searchJql(JQL.conversionDefects);
  writeRaw(path.join(RAW, "conversion-defects.json"), conversionDefects);
  writeRaw(path.join(RAW, "conversion-defects-p2.json"), []);
  writeRaw(path.join(RAW, "conversion-defects-p3.json"), []);

  console.log("Fetching P2-Prep…");
  const prep = await searchJql(JQL.prep);
  // Builder reads prep-page-01.json …; write one combined page and empty the rest.
  writeRaw(path.join(RAW, "prep-page-01.json"), prep);
  for (let i = 2; i <= 12; i++) {
    writeRaw(path.join(RAW, `prep-page-${String(i).padStart(2, "0")}.json`), []);
  }

  console.log("Fetching RICE parents…");
  const riceParents = await searchJql(JQL.riceParents);
  writeRaw(path.join(RAW, "rice-parents.json"), riceParents);

  console.log("Fetching RICE subtasks…");
  const riceSubs = await fetchSubsForParents(riceParents, "rice-subs");
  // Builder globs rice-subs-*.json — use a single file.
  writeRaw(path.join(RAW, "rice-subs-all.json"), riceSubs);

  console.log("Fetching linked Change Requests…");
  const crKeys = collectLinkedCrKeys(riceParents);
  let crs = [];
  if (crKeys.length) {
    for (const batch of chunk(crKeys, 50)) {
      const jql = `key in (${batch.join(", ")})`;
      crs.push(...(await searchJql(jql)));
    }
    crs = crs.filter((c) => (c.fields?.issuetype?.name || "") === "Change Request");
  }
  writeRaw(path.join(RAW, "crs.json"), crs);

  console.log("Fetching P2 Test Executions…");
  const testExecutions = await searchJql(JQL.testExecutions);
  writeRaw(path.join(RAW, "p2-test-executions.json"), testExecutions);

  console.log("Fetching P2 Testing defects…");
  const testDefects = await searchJql(JQL.testDefects);
  writeRaw(path.join(RAW, "p2-test-defects.json"), testDefects);

  console.log("Fetch complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
