/**
 * Build data/p2-testing.json from data/_raw/p2-test-*.json
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RAW = path.join(ROOT, "data", "_raw");
const OUT = path.join(ROOT, "data", "p2-testing.json");
const JIRA_BASE = "https://pwc-us-adv-cc-85ef5f50.atlassian.net/browse/";

const AS_OF =
  process.env.DASHBOARD_AS_OF ||
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

const WS_MAP = {
  "Source to Pay": { id: "S2P", name: "Source to Pay" },
  "Acquire to Retire": { id: "A2R", name: "Acquire to Retire" },
  "Plan to Report": { id: "P2R", name: "Plan to Report" },
  "EDMCS (COA), Close, Consol": { id: "EDM", name: "EDMCS (COA), Close, Consol" },
};

const STATUS_MAP = {
  Pass: "Passed",
  Passed: "Passed",
  Fail: "Failed",
  Failed: "Failed",
  Retest: "Retest",
  Withdrawn: "Withdrawn",
  "To Do": "Open",
  Open: "Open",
  Executing: "In Progress",
  "In Progress": "In Progress",
  Blocked: "Blocked",
  "On Hold": "On Hold",
};

const DEFECT_RESOLVED = new Set([
  "resolved",
  "completed",
  "done",
  "closed",
  "deferred",
  "rejected",
  "withdrawn",
]);

function loadIssues(name) {
  const p = path.join(RAW, name);
  if (!fs.existsSync(p)) return [];
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  return j.data?.issues || j.issues || [];
}

function cf(issue, name) {
  const entry = issue.fields?.customFields?.[name];
  if (!entry) return null;
  const v = entry.value;
  if (v == null) return null;
  if (typeof v === "object" && v.value != null) return v.value;
  return v;
}

function ymd(s) {
  if (!s) return null;
  return String(s).slice(0, 10);
}

function mapStatus(name) {
  if (!name) return "Open";
  return STATUS_MAP[name] || name;
}

function parseArea(description) {
  const text =
    typeof description === "string"
      ? description
      : description?.content
        ? JSON.stringify(description)
        : String(description || "");
  const m = text.match(/Business Process:\s*([^\n\r<]+)/i);
  return m ? m[1].trim() : "";
}

function workstreamOf(issue) {
  const raw = cf(issue, "Workstream") || "";
  const mapped = WS_MAP[raw];
  if (mapped) return mapped;
  // Fall back: abbreviate unknown workstream names
  if (/source\s*to\s*pay/i.test(raw)) return WS_MAP["Source to Pay"];
  if (/acquire\s*to\s*retire/i.test(raw)) return WS_MAP["Acquire to Retire"];
  if (/plan\s*to\s*report/i.test(raw)) return WS_MAP["Plan to Report"];
  if (/edm/i.test(raw)) return WS_MAP["EDMCS (COA), Close, Consol"];
  return { id: "S2P", name: raw || "Source to Pay" };
}

function priorityOf(issue) {
  const p = issue.fields?.priority?.name;
  if (!p || p === "No priority") return "Medium";
  return p;
}

function executedDateOf(issue, status) {
  const executed = ["Passed", "Failed", "Retest", "Withdrawn"].includes(status);
  if (!executed) return null;
  return ymd(issue.fields?.resolutiondate) || ymd(issue.fields?.updated);
}

function mapTestCase(issue) {
  const ws = workstreamOf(issue);
  const status = mapStatus(issue.fields?.status?.name);
  return {
    key: issue.key,
    summary: issue.fields?.summary || "",
    workstream: ws.id,
    workstreamName: ws.name,
    area: parseArea(issue.fields?.description) || cf(issue, "Module") || "",
    assignee: issue.fields?.assignee?.displayName || null,
    priority: priorityOf(issue),
    dueDate: ymd(issue.fields?.duedate),
    executedDate: executedDateOf(issue, status),
    status,
    defects: [],
    notes: "",
    created: ymd(issue.fields?.created),
    updated: ymd(issue.fields?.updated),
  };
}

function severityOf(issue) {
  const pri = issue.fields?.priority?.name;
  if (pri && pri !== "No priority") return pri;
  return cf(issue, "Complexity") || "Medium";
}

function mapDefect(issue) {
  const status = issue.fields?.status?.name || "";
  const resolved = DEFECT_RESOLVED.has(status.toLowerCase());
  const ws = workstreamOf(issue);
  return {
    key: issue.key,
    summary: issue.fields?.summary || "",
    assignee: issue.fields?.assignee?.displayName || null,
    status,
    type: cf(issue, "Defect Type") || "Defect",
    severity: severityOf(issue),
    dueDate: ymd(issue.fields?.duedate),
    raisedDate: ymd(issue.fields?.created),
    resolvedDate: resolved
      ? ymd(issue.fields?.resolutiondate) || ymd(issue.fields?.updated)
      : null,
    testCases: [],
    workstream: ws.id,
    area: cf(issue, "Module") || "",
  };
}

const tes = loadIssues("p2-test-executions.json");
const defs = loadIssues("p2-test-defects.json");

const testCases = tes.map(mapTestCase).sort((a, b) => {
  const da = a.dueDate || "";
  const db = b.dueDate || "";
  if (da !== db) return da.localeCompare(db);
  return a.key.localeCompare(b.key);
});
const defects = defs.map(mapDefect).sort((a, b) => a.key.localeCompare(b.key));

const workstreams = [
  WS_MAP["Source to Pay"],
  WS_MAP["Acquire to Retire"],
  WS_MAP["Plan to Report"],
  WS_MAP["EDMCS (COA), Close, Consol"],
];

const payload = {
  meta: {
    isSample: false,
    snapshot: AS_OF,
    lastUpdated: new Date().toISOString(), // dashboard refresh time, not a Jira issue updated date
    refreshNote: "Synced from Jira Cloud via scheduled refresh",
    source: "Jira / Xray",
    jiraBase: JIRA_BASE,
    window: { start: "2026-10-12", end: "2026-12-14" },
    jql: {
      testExecutions:
        'project = CONAMER1001932 AND issuetype = "Test Execution" AND "Test Cycle" = P2 AND (labels is EMPTY OR labels != conversion)',
      defects:
        'project = CONAMER1001932 AND issuetype = Defect AND "Test Cycle" = P2 AND (labels is EMPTY OR labels != conversion)',
    },
    workstreams,
    timelineEnd: "2026-12-14",
  },
  testCases,
  defects,
};

fs.writeFileSync(OUT, JSON.stringify(payload) + "\n");
console.log(
  `Wrote ${OUT} (testCases=${testCases.length}, defects=${defects.length}, asOf=${AS_OF})`
);
