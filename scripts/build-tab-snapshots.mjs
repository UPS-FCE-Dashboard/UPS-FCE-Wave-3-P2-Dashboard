/**
 * Build conversion.json, conversion-defects.json, prep.json, rice.json
 * from raw Jira dumps under data/_raw (MCP or scripts/fetch-jira-raw.mjs).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RAW = process.env.DASHBOARD_RAW_DIR
  ? path.resolve(process.env.DASHBOARD_RAW_DIR)
  : path.join(ROOT, "data", "_raw");
const OUT = process.env.DASHBOARD_OUT_DIR
  ? path.resolve(process.env.DASHBOARD_OUT_DIR)
  : path.join(ROOT, "data");
const AS_OF =
  process.env.DASHBOARD_AS_OF ||
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
const JIRA_BASE = "https://pwc-us-adv-cc-85ef5f50.atlassian.net/browse/";

const DONE = new Set(["Completed", "Resolved", "Done", "Closed"]);
const COMPLETE_PARENT = new Set(["Completed", "Resolved", "Done", "Closed"]);

const MODULE_MAP = {
  "Accounts Payable": "AP",
  Purchasing: "PO",
  "Cash Management": "CM",
  "Fixed Assets": "FA",
  "Fixed Asset": "FA",
  "Project Accounting": "PA",
  Inventory: "INV",
};

const STAGE_ORDER = [
  "Extract",
  "Profile",
  "Validate",
  "FBDI",
  "Approve",
  "Load",
  "Recon",
  "Sign-Off",
];

const RICE_CANON = [
  "Approve Functional Design",
  "Review Functional Design",
  "Functional Design",
  "FSD Handoff",
  "Update Technical Design",
  "Approve Technical Design",
  "Review Technical Design",
  "Technical Design",
  "Technical Analysis",
  "Build",
  "Unit Testing",
  "Functional Testing Handoff",
  "Functional Testing",
  "Defect Resolution",
  "Code Promotion",
];

const RICE_GROUPS = [
  {
    label: "Functional Design",
    match: [
      "Functional Design",
      "Review Functional Design",
      "Approve Functional Design",
      "FSD Handoff",
    ],
  },
  {
    label: "Tech Design",
    match: [
      "Technical Analysis",
      "Technical Design",
      "Review Technical Design",
      "Approve Technical Design",
      "Build",
    ],
  },
  { label: "Unit Testing", match: ["Unit Testing"] },
  {
    label: "Functional Testing",
    match: [
      "Functional Testing Handoff",
      "Functional Testing",
      "Defect Resolution",
    ],
  },
  {
    label: "Code Promotion",
    match: ["Code Promotion", "Update Technical Design"],
  },
];

function loadJson(name) {
  return JSON.parse(fs.readFileSync(path.join(RAW, name), "utf8"));
}

function issuesFrom(...names) {
  const out = [];
  for (const n of names) {
    const p = path.join(RAW, n);
    if (!fs.existsSync(p)) continue;
    const j = loadJson(n);
    const d = j.data || j;
    out.push(...(d.issues || []));
  }
  return out;
}

function cf(issue, label) {
  const cf = issue.fields?.customFields || {};
  const entry = cf[label];
  if (!entry) return null;
  const v = entry.value;
  if (v == null) return null;
  if (typeof v === "object" && v.value != null) return v.value;
  return v;
}

function stripHtml(s) {
  if (!s) return "";
  return String(s)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function mapModule(mod) {
  if (!mod) return "";
  if (MODULE_MAP[mod]) return MODULE_MAP[mod];
  const parts = String(mod).split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 3).toUpperCase();
  return parts.map((p) => p[0]).join("").toUpperCase();
}

function collapseParentStatus(name) {
  if (COMPLETE_PARENT.has(name)) return "Complete";
  if (name === "Blocked") return "Blocked";
  if (name === "Not Started") return "Not Started";
  return "In Progress";
}

function envFrom(id, summary) {
  const src = `${id || ""} ${summary || ""}`;
  if (/\bP590\b/i.test(src)) return "P590";
  if (/\bACC\b/i.test(src)) return "ACC";
  if (/\bBLK\b|\bBlackline\b/i.test(src)) return "BLK";
  const m = src.match(/\b(P\d{3})\b/);
  return m ? m[1] : "";
}

function cleanObject(summary) {
  return String(summary || "")
    .replace(/\s*Conversion Execution\s*-\s*[A-Za-z0-9]+$/i, "")
    .replace(/\s*Conversion Execution$/i, "")
    .trim();
}

function checklistLabel(summary) {
  let s = String(summary || "");
  // Strip leading ID#
  s = s.replace(/^FCE-CNV-[A-Z0-9-]+\s+/i, "");
  // Take phrase before " - "
  const dash = s.indexOf(" - ");
  if (dash > 0) s = s.slice(0, dash);
  return s.trim();
}

function stageRank(label) {
  const l = label.toLowerCase();
  if (/extract/.test(l)) return 0;
  if (/profile/.test(l) && !/validate/.test(l)) return 1;
  if (/validate/.test(l)) return 2;
  if (/fbdi|load files/.test(l)) return 3;
  if (/approve/.test(l)) return 4;
  if (/^load data|load data/.test(l) && !/post load/.test(l)) return 5;
  if (/recon/.test(l)) return 6;
  if (/sign-?off|post load/.test(l)) return 7;
  return 50;
}

function plannedDate(issue) {
  const p = cf(issue, "Planned Complete Date");
  if (p) return String(p).slice(0, 10);
  const d = issue.fields?.duedate;
  return d ? String(d).slice(0, 10) : "";
}

function daysOverdue(planned, asOf, status) {
  if (!planned) return null;
  if (DONE.has(status)) return null;
  const a = new Date(asOf + "T00:00:00");
  const p = new Date(planned + "T00:00:00");
  if (Number.isNaN(a) || Number.isNaN(p)) return null;
  const diff = Math.floor((a - p) / 86400000);
  return diff > 0 ? diff : null;
}

function riceCanonicalStep(label) {
  const lower = String(label || "").toLowerCase();
  // Fold Coupa IH / ERPP dual-track into same stage name
  const cleaned = lower
    .replace(/\bcoupa\s*ih\b/g, "")
    .replace(/\berpp\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (
    RICE_CANON.find((k) => cleaned.includes(k.toLowerCase())) ||
    RICE_CANON.find((k) => lower.includes(k.toLowerCase())) ||
    ""
  );
}

function riceGroupLabel(stepLabel) {
  const canon = riceCanonicalStep(stepLabel);
  const g = RICE_GROUPS.find((x) => x.match.includes(canon));
  return g ? g.label : canon || stepLabel;
}

function relatedObjectFromSummary(summary) {
  let s = String(summary || "");
  // Drop leading env prefix like "P590 - "
  s = s.replace(/^(P\d{3}|ACC|BLK|Blackline)\s*\/?\s*(ACC|P\d{3})?\s*-\s*/i, "");
  s = s.replace(/^(P\d{3}|ACC|BLK)\s*-\s*/i, "");
  // Take up to " R1 " or " Conversion" trailing qualifiers
  const m = s.match(/^(.+?)\s+(?:R1\b|Conversion\b)/i);
  if (m) return m[1].trim();
  const dash = s.indexOf(" - ");
  if (dash > 0) return s.slice(0, dash).trim();
  return s.trim();
}

const CR_DEFECT_DONE = new Set([
  "resolved",
  "withdrawn",
  "closed",
  "cancelled",
  "canceled",
  "rejected",
  "done",
  "completed",
]);

function crLinkedDefects(cr) {
  const out = [];
  for (const link of cr.fields?.issuelinks || []) {
    for (const side of [link.outwardIssue, link.inwardIssue]) {
      if (side?.fields?.issuetype?.name === "Defect") {
        out.push({
          key: side.key,
          summary: side.fields?.summary || "",
          status: side.fields?.status?.name || "",
          assignee: side.fields?.assignee?.displayName || null,
        });
      }
    }
  }
  // de-dupe by key
  const seen = new Set();
  return out.filter((d) => {
    if (seen.has(d.key)) return false;
    seen.add(d.key);
    return true;
  });
}

function crDelivery(cr, defects) {
  const crStatus = cr.fields?.status?.name || "";
  if (crStatus === "Withdrawn") return "Withdrawn";
  if (!defects.length) return "No linked defect";
  const open = defects.filter(
    (d) => !CR_DEFECT_DONE.has(String(d.status || "").toLowerCase())
  );
  return open.length ? "Open" : "Completed";
}

// ---------- 1) conversion.json ----------
function buildConversion() {
  const parents = issuesFrom("conversion-parents.json");
  const subs = [
    ...issuesFrom("conversion-subtasks.json"),
    ...issuesFrom("conversion-subtasks-p2.json"),
  ];
  const byKey = Object.fromEntries(subs.map((s) => [s.key, s]));

  const items = parents.map((p) => {
    const id = cf(p, "ID#") || p.key;
    const mod = cf(p, "Module");
    const statusName = p.fields?.status?.name || "";
    const priorityName = p.fields?.priority?.name || "Medium";
    const checklist = (p.fields?.subtasks || []).map((st) => {
      const full = byKey[st.key] || st;
      const label = checklistLabel(full.fields?.summary || st.fields?.summary || "");
      const status = full.fields?.status?.name || st.fields?.status?.name || "";
      const dueDate = plannedDate(full) || "";
      const item = {
        label,
        done: DONE.has(status),
        dueDate,
        status,
      };
      const preds = [];
      for (const link of full.fields?.issuelinks || []) {
        if (link.type?.name === "Blocks" && link.outwardIssue) {
          preds.push(link.outwardIssue.key);
        }
      }
      if (preds.length) {
        item.predecessorFor = preds;
        item.isPredecessor = true;
      }
      return item;
    });

    checklist.sort((a, b) => {
      const ra = stageRank(a.label);
      const rb = stageRank(b.label);
      if (ra !== rb) return ra - rb;
      return String(a.label).localeCompare(String(b.label));
    });

    const blockers = checklist
      .filter((c) => !c.done && /blocked/i.test(c.status))
      .map((c) => c.label);

    return {
      key: id,
      object: cleanObject(p.fields?.summary),
      subledger: mapModule(mod),
      phase: "Execution",
      status: collapseParentStatus(statusName),
      owner: p.fields?.assignee?.displayName || "Unassigned",
      environment: envFrom(id, p.fields?.summary),
      dueDate: plannedDate(p) || "",
      priority: priorityName === "No priority" ? "Medium" : priorityName,
      blocker: blockers.join("; "),
      checklist,
    };
  });

  items.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  return { asOf: AS_OF, jiraBase: JIRA_BASE, items };
}

// ---------- 2) conversion-defects.json ----------
function buildDefects() {
  const issues = issuesFrom(
    "conversion-defects.json",
    "conversion-defects-p2.json",
    "conversion-defects-p3.json"
  );
  const items = issues.map((d) => {
    const mod = cf(d, "Module");
    const pri = d.fields?.priority?.name || "Not Set";
    const workaround = cf(d, "Workaround");
    const created = d.fields?.created
      ? String(d.fields.created).slice(0, 10)
      : "";
    return {
      key: d.key,
      issueType: d.fields?.issuetype?.name || "Defect",
      labels: d.fields?.labels || [],
      summary: d.fields?.summary || "",
      subledger: mapModule(mod),
      relatedObject: relatedObjectFromSummary(d.fields?.summary),
      severity: pri === "No priority" ? "Not Set" : pri,
      status: d.fields?.status?.name || "",
      owner: d.fields?.assignee?.displayName || "Unassigned",
      dateIdentified: created,
      targetRetestDate: d.fields?.duedate
        ? String(d.fields.duedate).slice(0, 10)
        : "",
      notes: stripHtml(workaround) || "",
    };
  });
  items.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  return { asOf: AS_OF, items };
}

// ---------- 3) prep.json ----------
function buildPrep() {
  const pages = [];
  for (let i = 1; i <= 12; i++) {
    const name = `prep-page-${String(i).padStart(2, "0")}.json`;
    if (fs.existsSync(path.join(RAW, name))) pages.push(name);
  }
  const issues = issuesFrom(...pages);
  const nodes = issues.map((n) => {
    const ws = cf(n, "Workstream");
    const statusCat =
      n.fields?.status?.statusCategory?.key ||
      n.fields?.statusCategory?.key ||
      "";
    return {
      key: n.key,
      summary: n.fields?.summary || "",
      type: n.fields?.issuetype?.name || "",
      assignee: n.fields?.assignee?.displayName || null,
      status: n.fields?.status?.name || "",
      statusCat,
      due: n.fields?.duedate ? String(n.fields.duedate).slice(0, 10) : null,
      workstream: ws || "PMO",
      parent: n.fields?.parent?.key || null,
      labeled: true,
    };
  });
  nodes.sort((a, b) => {
    const na = Number(String(a.key).split("-").pop());
    const nb = Number(String(b.key).split("-").pop());
    return na - nb;
  });
  return { asOf: AS_OF, jiraBase: JIRA_BASE, nodes };
}

// ---------- 4) rice.json ----------
function buildRice() {
  const parents = issuesFrom("rice-parents.json");
  const subFiles = fs
    .readdirSync(RAW)
    .filter((f) => /^rice-subs-/.test(f) && f.endsWith(".json"));
  const subs = issuesFrom(...subFiles);
  const subsByParent = {};
  for (const s of subs) {
    const pk = s.fields?.parent?.key;
    if (!pk) continue;
    (subsByParent[pk] ||= []).push(s);
  }

  const crs = issuesFrom("crs.json");
  const crByKey = Object.fromEntries(crs.map((c) => [c.key, c]));

  const rice = parents.map((p) => {
    const id = cf(p, "ID#") || "";
    const workstream = cf(p, "Workstream") || "";
    const module = cf(p, "Module") || "";
    const status = p.fields?.status?.name || "";
    const parentSubs = p.fields?.subtasks || [];
    const detailed = subsByParent[p.key] || [];
    const detailByKey = Object.fromEntries(detailed.map((s) => [s.key, s]));

    const allSubs = parentSubs.map((st, idx) => {
      const full = detailByKey[st.key] || st;
      const summary = full.fields?.summary || st.fields?.summary || "";
      const stStatus = full.fields?.status?.name || st.fields?.status?.name || "";
      const planned = plannedDate(full);
      const stepRaw = summary.includes(" - ")
        ? summary.slice(summary.lastIndexOf(" - ") + 3).trim()
        : summary;
      // Keep fine-grained stage names (Functional Design, Review Technical Design, …)
      // so the dashboard can fold them into FD/TD/UT/FT/CP. Do not collapse to
      // the five group labels here — "Tech Design" does not match "Technical Design".
      const step =
        riceCanonicalStep(summary) ||
        riceCanonicalStep(stepRaw) ||
        stepRaw;

      return {
        jiraOrder: idx,
        step,
        plannedComplete: planned || null,
        assignee: full.fields?.assignee?.displayName || null,
        status: stStatus,
        daysOverdue: daysOverdue(planned, AS_OF, stStatus),
      };
    });

    const subTotal = allSubs.length;
    const subDone = allSubs.filter((s) => DONE.has(s.status)).length;
    const subOpen = subTotal - subDone;
    const delayedCount = allSubs.filter(
      (s) => s.daysOverdue != null && s.daysOverdue > 0
    ).length;

    const linkedCrKeys = [];
    for (const link of p.fields?.issuelinks || []) {
      for (const side of [link.outwardIssue, link.inwardIssue]) {
        if (side?.fields?.issuetype?.name === "Change Request") {
          linkedCrKeys.push(side.key);
        }
      }
    }
    const uniqCrs = [...new Set(linkedCrKeys)];
    let openCr = 0,
      completedCr = 0,
      noDefCr = 0;
    for (const k of uniqCrs) {
      const cr = crByKey[k];
      if (!cr) continue;
      const defects = crLinkedDefects(cr);
      const delivery = crDelivery(cr, defects);
      if (delivery === "Open") openCr++;
      else if (delivery === "Completed") completedCr++;
      else if (delivery === "No linked defect") noDefCr++;
    }

    const bucket = COMPLETE_PARENT.has(status) ? "Complete" : "In Progress";
    let risk = "Stable";
    let riskWhy = "No delayed sub-tasks, not blocked, no open overdue CR";
    if (status === "Blocked" || openCr > 0 || delayedCount > 0) {
      if (status === "Blocked" || delayedCount >= 3 || openCr >= 2) {
        risk = "High";
        riskWhy = [
          status === "Blocked" ? "Parent blocked" : null,
          delayedCount ? `${delayedCount} delayed sub-tasks` : null,
          openCr ? `${openCr} open CR` : null,
        ]
          .filter(Boolean)
          .join("; ");
      } else {
        risk = "Watch";
        riskWhy = [
          delayedCount ? `${delayedCount} delayed sub-tasks` : null,
          openCr ? `${openCr} open CR` : null,
        ]
          .filter(Boolean)
          .join("; ");
      }
    }

    return {
      key: p.key,
      summary: p.fields?.summary || "",
      id,
      type: p.fields?.issuetype?.name || "",
      status,
      workstream,
      module,
      assignee: p.fields?.assignee?.displayName || null,
      subTotal,
      subDone,
      subOpen,
      delayedCount,
      bucket,
      risk,
      riskWhy,
      openCr,
      completedCr,
      noDefCr,
      crs: uniqCrs.map((key) => ({ key })),
      allSubs,
    };
  });

  const crOut = crs.map((c) => {
    const st = c.fields?.status?.name || "";
    const due = c.fields?.duedate ? String(c.fields.duedate).slice(0, 10) : null;
    const defects = crLinkedDefects(c);
    const openDefectCount = defects.filter(
      (d) => !CR_DEFECT_DONE.has(String(d.status || "").toLowerCase())
    ).length;
    const delivery = crDelivery(c, defects);
    const dueOverdue =
      !!due &&
      delivery === "Open" &&
      new Date(due + "T00:00:00") < new Date(AS_OF + "T00:00:00");
    return {
      key: c.key,
      summary: c.fields?.summary || "",
      assignee: c.fields?.assignee?.displayName || null,
      crStatus: st,
      due,
      dueOverdue,
      defectCount: defects.length,
      openDefectCount,
      delivery: delivery === "Withdrawn" ? "No linked defect" : delivery,
      defects,
    };
  });

  const totalRice = rice.length;
  const complete = rice.filter((r) => r.bucket === "Complete").length;
  const delayed = rice.filter(
    (r) => r.bucket !== "Complete" && r.delayedCount > 0
  ).length;
  const onTarget = rice.filter(
    (r) => r.bucket !== "Complete" && r.delayedCount === 0
  ).length;
  const highRisk = rice.filter((r) => r.risk === "High").length;
  const watch = rice.filter((r) => r.risk === "Watch").length;
  const stable = rice.filter((r) => r.risk === "Stable").length;
  const overdueSubtasks = rice.reduce(
    (n, r) => n + r.allSubs.filter((s) => s.daysOverdue > 0).length,
    0
  );
  const uniqueCrs = crOut.length;
  const crOpen = crOut.filter((c) => c.delivery === "Open").length;
  const crCompleted = crOut.filter((c) => c.delivery === "Completed").length;
  const crWithdrawn = crOut.filter((c) => c.crStatus === "Withdrawn").length;
  const crNoDefect = crOut.filter(
    (c) => c.delivery === "No linked defect" && c.crStatus !== "Withdrawn"
  ).length;

  const metrics = {
    totalRice,
    complete,
    delayed,
    onTarget,
    pctComplete: totalRice
      ? Math.round((complete / totalRice) * 1000) / 10
      : 0,
    pctDelayed: totalRice
      ? Math.round((delayed / totalRice) * 1000) / 10
      : 0,
    pctOnTarget: totalRice
      ? Math.round((onTarget / totalRice) * 1000) / 10
      : 0,
    highRisk,
    watch,
    stable,
    overdueSubtasks,
    uniqueCrs,
    crOpen,
    crCompleted,
    crWithdrawn,
    crNoDefect,
  };

  return {
    asOf: AS_OF,
    filters: {
      project: "CONAMER1001932",
      component: "Release 1",
      testCycle: "P2",
      fixVersion: "Wave 3",
      status: "not Withdrawn",
    },
    metrics,
    rice,
    crs: crOut,
  };
}

function writeOut(name, obj) {
  const p = path.join(OUT, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
  console.log(`Wrote ${name}`);
}

const conversion = buildConversion();
writeOut("conversion.json", conversion);
console.log(`  conversion items=${conversion.items.length}`);

const defects = buildDefects();
writeOut("conversion-defects.json", defects);
console.log(`  defects items=${defects.items.length}`);

const prep = buildPrep();
writeOut("prep.json", prep);
console.log(`  prep nodes=${prep.nodes.length}`);

const rice = buildRice();
writeOut("rice.json", rice);
console.log(
  `  rice=${rice.rice.length} crs=${rice.crs.length} metrics=`,
  rice.metrics
);
