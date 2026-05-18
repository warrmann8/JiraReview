// Jira client skeleton.
//
// This module exposes the interface the rest of the app calls into to pull
// Jira data. The functions are stubs that throw NotImplementedError with
// exact instructions on what to implement. Once the real implementations
// are dropped in (one engineer task — see JIRA-HANDOFF.md), every caller
// in server.js and scripts/seed.js works without further changes.
//
// Auth: Atlassian Cloud Basic Auth — Authorization: Basic base64(email:token).
//   - JIRA_BASE_URL, e.g. https://ashley-furniture-team.atlassian.net
//   - JIRA_EMAIL — service-account email
//   - JIRA_API_TOKEN — created at https://id.atlassian.com/manage-profile/security/api-tokens
//
// REST: Atlassian Cloud REST API v3. Endpoints used:
//   - POST /rest/api/3/search/jql  (paginated; nextPageToken)
//   - GET  /rest/api/3/issue/{key}?fields=...
//   - GET  /rest/api/3/issue/{key}?expand=names,renderedFields
//
// Rate limits: ~10 req/s per org (search endpoint); the implementation
// should respect Retry-After on 429 and back off. See JIRA-HANDOFF.md.

const REQUIRED_ENV = ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"];

class JiraNotConfiguredError extends Error {
  constructor(missing) {
    super(`Jira API not configured. Missing env: ${missing.join(", ")}. See JIRA-HANDOFF.md.`);
    this.code = "JIRA_NOT_CONFIGURED";
    this.missing = missing;
  }
}

class JiraNotImplementedError extends Error {
  constructor(fn, doc) {
    super(`Jira function ${fn} is not yet implemented. ${doc} See JIRA-HANDOFF.md.`);
    this.code = "JIRA_NOT_IMPLEMENTED";
    this.fn = fn;
  }
}

function checkConfigured() {
  const missing = REQUIRED_ENV.filter(k => !process.env[k]);
  if (missing.length) throw new JiraNotConfiguredError(missing);
  return {
    baseUrl: process.env.JIRA_BASE_URL.replace(/\/$/, ""),
    email: process.env.JIRA_EMAIL,
    token: process.env.JIRA_API_TOKEN
  };
}

function isConfigured() {
  return REQUIRED_ENV.every(k => !!process.env[k]);
}

// ---- Field map ----
//
// The internal item shape used everywhere downstream. Keep in sync with the
// items written by scripts/seed.js — same field names.
//
//   {
//     key, summary, type, status, priority,
//     parent_key, parent_summary,   // <-- the Initiative linkage
//     url, description, labels, assignee, updated,
//     project_key, bu_slug          // set by the caller; jira doesn't know BUs
//   }
//
// Atlassian field mapping reference:
//   issue.key                              -> key
//   issue.fields.summary                   -> summary
//   issue.fields.issuetype.name            -> type   ("Epic" | "Initiative" | "Story" | ...)
//   issue.fields.status.name               -> status
//   issue.fields.priority?.name            -> priority
//   issue.fields.parent?.key               -> parent_key       (the Epic's parent Initiative)
//   issue.fields.parent?.fields?.summary   -> parent_summary
//   issue.fields.description (ADF doc)     -> description      (flatten via flattenAdf)
//   issue.fields.labels                    -> labels[]
//   issue.fields.assignee?.displayName     -> assignee
//   issue.fields.updated                   -> updated (ISO 8601)
//
// Optional / customer-specific:
//   customfield_10014 (Epic Link)     -> sometimes used on Stories pointing to Epic
//   customfield_10008 (Initiative Link) -> may need to be discovered per tenant
//
// The exact custom field IDs for AFI's Jira instance are not known yet —
// confirm with the Jira admin during wire-up.
function normalizeIssue(issue) {
  if (!issue || !issue.fields) throw new Error("normalizeIssue: invalid issue payload");
  const f = issue.fields;
  return {
    key: issue.key,
    summary: f.summary || "",
    type: (f.issuetype && f.issuetype.name) || "",
    status: (f.status && f.status.name) || "",
    priority: (f.priority && f.priority.name) || "",
    parent_key: (f.parent && f.parent.key) || "",
    parent_summary: (f.parent && f.parent.fields && f.parent.fields.summary) || "",
    url: process.env.JIRA_BASE_URL ? `${process.env.JIRA_BASE_URL.replace(/\/$/, "")}/browse/${issue.key}` : "",
    description: flattenAdf(f.description) || "",
    labels: Array.isArray(f.labels) ? f.labels : [],
    assignee: (f.assignee && f.assignee.displayName) || "",
    updated: f.updated || ""
  };
}

// ---- ADF → plain text ----
//
// Atlassian Document Format (ADF) is a nested JSON tree. For our LLM scorer
// we only need readable plain text — headings, paragraphs, lists, code,
// inline marks flattened to newlines and spaces.
function flattenAdf(doc) {
  if (!doc) return "";
  if (typeof doc === "string") return doc;
  if (typeof doc !== "object") return "";

  const parts = [];
  function walk(node) {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === "text" && typeof node.text === "string") {
      parts.push(node.text);
      return;
    }
    if (node.type === "hardBreak") { parts.push("\n"); return; }
    if (node.content) walk(node.content);
    if (node.type === "paragraph" || node.type === "heading" || node.type === "listItem" || node.type === "codeBlock") {
      parts.push("\n");
    }
  }
  walk(doc);
  return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
}

// ---- API surface (stubs — implementer fills these in) ----

/**
 * Search Epics (and Initiatives, if `includeInitiatives: true`) for a project.
 * Returns an array of normalized item shapes — same as scripts/seed.js writes.
 *
 * @param {string} projectKey  e.g. "DSI"
 * @param {object} options
 * @param {string} [options.statusCategory]  "In Progress" | "To Do" | "Done"
 * @param {string} [options.jqlExtra]        Optional JQL clause appended with AND
 * @param {number} [options.updatedSince]    days; e.g. 30 -> "updated >= -30d"
 * @param {number} [options.limit]           default 500
 * @param {boolean} [options.includeInitiatives]  also return Initiative-type issues
 * @returns {Promise<Array<NormalizedItem>>}
 */
async function searchEpics(projectKey, options = {}) {
  checkConfigured();
  // TODO: implement. Recipe:
  //   1. Build JQL:
  //        const parts = [`project = "${projectKey}"`,
  //          options.includeInitiatives
  //            ? `issuetype in (Epic, Initiative)`
  //            : `issuetype = Epic`];
  //        if (options.statusCategory) parts.push(`statusCategory = "${options.statusCategory}"`);
  //        if (options.updatedSince)   parts.push(`updated >= -${options.updatedSince}d`);
  //        if (options.jqlExtra)       parts.push(options.jqlExtra);
  //        const jql = parts.join(" AND ") + " ORDER BY updated DESC";
  //   2. POST {baseUrl}/rest/api/3/search/jql with:
  //        { jql, fields: ["summary","issuetype","status","priority","parent","labels","assignee","updated","description"],
  //          maxResults: 100, nextPageToken }
  //   3. Page until nextPageToken absent or limit hit.
  //   4. Return issues.map(normalizeIssue).
  //   5. Backoff on 429 honoring Retry-After header.
  throw new JiraNotImplementedError("searchEpics",
    `Search Epics in project "${projectKey}" using JQL POST /rest/api/3/search/jql and return issues.map(normalizeIssue).`);
}

/**
 * Fetch one Epic (or any issue) by key. Returns the normalized item shape.
 *
 * @param {string} key  e.g. "DSI-372"
 * @returns {Promise<NormalizedItem>}
 */
async function getEpic(key) {
  checkConfigured();
  // TODO: GET {baseUrl}/rest/api/3/issue/{key}?fields=summary,issuetype,status,priority,parent,labels,assignee,updated,description
  // Then return normalizeIssue(json).
  throw new JiraNotImplementedError("getEpic",
    `Fetch single issue "${key}" via GET /rest/api/3/issue/${key} and return normalizeIssue(json).`);
}

/**
 * Convenience: fetch an Initiative by key. Same as getEpic but typically
 * used to verify a parent_key resolves to an actual Initiative-type issue.
 *
 * @param {string} key  e.g. "AFIINIT-31"
 * @returns {Promise<NormalizedItem>}
 */
async function getInitiative(key) {
  checkConfigured();
  // TODO: same shape as getEpic; the only reason this is separate is for
  // call-site clarity. Implementer may collapse it into getEpic + a type
  // assertion if preferred.
  throw new JiraNotImplementedError("getInitiative",
    `Fetch Initiative "${key}" via GET /rest/api/3/issue/${key} and verify issuetype.name === "Initiative".`);
}

/**
 * Lightweight reachability check. Returns { ok: true, accountId, baseUrl }
 * or throws JiraNotConfiguredError / a fetch error. Used by /api/jira/ping.
 */
async function ping() {
  checkConfigured();
  // TODO: GET /rest/api/3/myself — returns { accountId, displayName }.
  throw new JiraNotImplementedError("ping",
    `Call GET /rest/api/3/myself to verify the credentials work.`);
}

module.exports = {
  isConfigured,
  searchEpics,
  getEpic,
  getInitiative,
  ping,
  normalizeIssue,
  flattenAdf,
  JiraNotConfiguredError,
  JiraNotImplementedError,
  REQUIRED_ENV
};
