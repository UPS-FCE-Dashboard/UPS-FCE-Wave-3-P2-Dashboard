/**
 * Minimal Jira Cloud REST helper (Basic auth: email + API token).
 */
import fs from "fs";
import path from "path";

export const JIRA_HOST =
  process.env.JIRA_BASE_URL?.replace(/\/$/, "") ||
  "https://pwc-us-adv-cc-85ef5f50.atlassian.net";

export const FIELD_IDS = {
  "ID#": "customfield_10047",
  Module: "customfield_10058",
  "Planned Complete Date": "customfield_10074",
  Workstream: "customfield_10049",
  Workaround: "customfield_10184",
  "Test Cycle": "customfield_10087",
  Complexity: "customfield_10154",
  "Defect Type": "customfield_10199",
};

const ID_TO_NAME = Object.fromEntries(
  Object.entries(FIELD_IDS).map(([name, id]) => [id, name])
);

function authHeader() {
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  if (!email || !token) {
    throw new Error(
      "Set JIRA_EMAIL and JIRA_API_TOKEN (Jira Cloud API token) before running."
    );
  }
  return "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
}

async function jiraFetch(urlPath, options = {}) {
  const url = urlPath.startsWith("http") ? urlPath : `${JIRA_HOST}${urlPath}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: authHeader(),
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jira ${res.status} ${url}: ${body.slice(0, 500)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

/** Normalize a REST issue into the MCP-like shape used by the builders. */
export function toMcpIssue(issue) {
  const f = issue.fields || {};
  const customFields = {};
  for (const [id, name] of Object.entries(ID_TO_NAME)) {
    if (f[id] !== undefined && f[id] !== null) {
      customFields[name] = { id, value: f[id] };
    }
  }
  // Also pick up any customFields already present (MCP dumps).
  if (f.customFields && typeof f.customFields === "object") {
    Object.assign(customFields, f.customFields);
  }
  return {
    id: issue.id,
    key: issue.key,
    fields: {
      summary: f.summary,
      status: f.status,
      statusCategory: f.status?.statusCategory,
      assignee: f.assignee,
      priority: f.priority,
      labels: f.labels || [],
      duedate: f.duedate,
      created: f.created,
      updated: f.updated,
      resolutiondate: f.resolutiondate,
      components: f.components,
      fixVersions: f.fixVersions,
      issuetype: f.issuetype,
      subtasks: f.subtasks || [],
      issuelinks: f.issuelinks || [],
      parent: f.parent,
      description: f.description,
      customFields,
    },
  };
}

const DEFAULT_FIELDS = [
  "summary",
  "status",
  "assignee",
  "priority",
  "labels",
  "duedate",
  "created",
  "updated",
  "resolutiondate",
  "components",
  "fixVersions",
  "issuetype",
  "subtasks",
  "issuelinks",
  "parent",
  "description",
  ...Object.values(FIELD_IDS),
];

/**
 * Paginated JQL search via /rest/api/3/search/jql (nextPageToken).
 * Falls back to classic /rest/api/3/search if needed.
 */
export async function searchJql(jql, { fields = DEFAULT_FIELDS, pageSize = 100 } = {}) {
  // Prefer enhanced /search/jql; fall back to classic /search on failure.
  try {
    const issues = [];
    let nextPageToken = undefined;
    for (;;) {
      const body = { jql, maxResults: pageSize, fields };
      if (nextPageToken) body.nextPageToken = nextPageToken;
      const data = await jiraFetch("/rest/api/3/search/jql", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const batch = data.issues || [];
      issues.push(...batch.map(toMcpIssue));
      if (data.isLast || !data.nextPageToken || batch.length === 0) break;
      nextPageToken = data.nextPageToken;
    }
    return issues;
  } catch (err) {
    console.warn("Enhanced JQL search failed; trying classic /search.", err.message);
  }

  const issues = [];
  let startAt = 0;
  for (;;) {
    const q = new URLSearchParams({
      jql,
      startAt: String(startAt),
      maxResults: String(pageSize),
      fields: fields.join(","),
    });
    const data = await jiraFetch(`/rest/api/3/search?${q}`);
    const batch = data.issues || [];
    issues.push(...batch.map(toMcpIssue));
    startAt += batch.length;
    if (startAt >= (data.total || 0) || batch.length === 0) break;
  }
  return issues;
}

export function writeRaw(filePath, issues, extra = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = {
    data: {
      issues,
      isLast: true,
      ...extra,
    },
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + "\n");
  console.log(`Wrote ${filePath} (${issues.length} issues)`);
}

export function todayIso(timeZone = "America/New_York") {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
