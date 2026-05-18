// Tests for lib/jira.js — focuses on the real implementations
// (normalizeIssue, flattenAdf) and the configuration error paths. The
// network-touching stubs are out of scope until they're filled in.

const test = require("node:test");
const assert = require("node:assert/strict");
const jira = require("../lib/jira");

test("isConfigured() is false when env vars are missing", () => {
  const saved = {};
  for (const k of jira.REQUIRED_ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    assert.equal(jira.isConfigured(), false);
  } finally {
    for (const k of jira.REQUIRED_ENV) if (saved[k] !== undefined) process.env[k] = saved[k];
  }
});

test("flattenAdf collapses paragraphs and headings to plain text", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Title" }] },
      { type: "paragraph", content: [
        { type: "text", text: "Hello " },
        { type: "text", text: "world", marks: [{ type: "strong" }] }
      ] }
    ]
  };
  const out = jira.flattenAdf(doc);
  assert.match(out, /Title/);
  assert.match(out, /Hello world/);
});

test("flattenAdf returns empty string for null / non-objects", () => {
  assert.equal(jira.flattenAdf(null), "");
  assert.equal(jira.flattenAdf(undefined), "");
  assert.equal(jira.flattenAdf(42), "");
});

test("normalizeIssue maps Jira fields to the app's internal shape", () => {
  const saved = process.env.JIRA_BASE_URL;
  process.env.JIRA_BASE_URL = "https://example.atlassian.net";
  try {
    const issue = {
      key: "DSI-42",
      fields: {
        summary: "Demand planning data ingest",
        issuetype: { name: "Epic" },
        status: { name: "In Progress" },
        priority: { name: "High" },
        parent: { key: "AFIINIT-31", fields: { summary: "Next-Gen Supply Chain" } },
        labels: ["ROADMAP"],
        assignee: { displayName: "Jane Doe" },
        updated: "2026-04-22T14:05:00.000Z",
        description: null
      }
    };
    const out = jira.normalizeIssue(issue);
    assert.equal(out.key, "DSI-42");
    assert.equal(out.summary, "Demand planning data ingest");
    assert.equal(out.type, "Epic");
    assert.equal(out.status, "In Progress");
    assert.equal(out.priority, "High");
    assert.equal(out.parent_key, "AFIINIT-31");
    assert.equal(out.parent_summary, "Next-Gen Supply Chain");
    assert.equal(out.assignee, "Jane Doe");
    assert.equal(out.url, "https://example.atlassian.net/browse/DSI-42");
    assert.deepEqual(out.labels, ["ROADMAP"]);
  } finally {
    if (saved === undefined) delete process.env.JIRA_BASE_URL;
    else process.env.JIRA_BASE_URL = saved;
  }
});

test("normalizeIssue handles missing optional fields without throwing", () => {
  const out = jira.normalizeIssue({ key: "X-1", fields: { summary: "minimal" } });
  assert.equal(out.key, "X-1");
  assert.equal(out.summary, "minimal");
  assert.equal(out.type, "");
  assert.equal(out.status, "");
  assert.equal(out.parent_key, "");
  assert.deepEqual(out.labels, []);
});

test("stub functions throw NotConfigured when env is missing", async () => {
  const saved = {};
  for (const k of jira.REQUIRED_ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    await assert.rejects(() => jira.ping(), e => e && e.code === "JIRA_NOT_CONFIGURED");
    await assert.rejects(() => jira.searchEpics("DSI"), e => e && e.code === "JIRA_NOT_CONFIGURED");
    await assert.rejects(() => jira.getEpic("DSI-1"), e => e && e.code === "JIRA_NOT_CONFIGURED");
  } finally {
    for (const k of jira.REQUIRED_ENV) if (saved[k] !== undefined) process.env[k] = saved[k];
  }
});

test("stub functions throw NotImplemented when configured but not yet wired", async () => {
  const saved = {};
  for (const k of jira.REQUIRED_ENV) { saved[k] = process.env[k]; }
  process.env.JIRA_BASE_URL = "https://example.atlassian.net";
  process.env.JIRA_EMAIL = "test@example.com";
  process.env.JIRA_API_TOKEN = "fake";
  try {
    await assert.rejects(() => jira.ping(), e => e && e.code === "JIRA_NOT_IMPLEMENTED");
    await assert.rejects(() => jira.searchEpics("DSI"), e => e && e.code === "JIRA_NOT_IMPLEMENTED");
  } finally {
    for (const k of jira.REQUIRED_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
