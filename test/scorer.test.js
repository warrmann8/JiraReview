// Targeted tests for the LLM scorer module. Covers the synchronous bits —
// epic-level gating, schema normalization invariants — without needing a
// live provider. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

// The scorer reads prompts/item-review.md at require time. That's
// expected; the file must exist for any of these tests to pass.
const scorer = require("../lib/scorer");

test("isEpicLevel accepts Epic and Initiative (case-insensitive)", () => {
  assert.equal(scorer.isEpicLevel("Epic"), true);
  assert.equal(scorer.isEpicLevel("epic"), true);
  assert.equal(scorer.isEpicLevel("Initiative"), true);
  assert.equal(scorer.isEpicLevel("INITIATIVE"), true);
});

test("isEpicLevel rejects child-issue types", () => {
  for (const t of ["Story", "Task", "Sub-task", "Bug", "Test", "Idea", "Discovery", ""]) {
    assert.equal(scorer.isEpicLevel(t), false, `should reject "${t}"`);
  }
  assert.equal(scorer.isEpicLevel(undefined), false);
  assert.equal(scorer.isEpicLevel(null), false);
});

test("ALLOWED_VERDICTS is exactly the four expected verdicts", () => {
  assert.deepEqual(scorer.ALLOWED_VERDICTS.slice().sort(), ["FLAG", "FOLD", "KEEP", "STOP"]);
});

test("EPIC_LEVEL_TYPES is exported as an array of lowercase strings", () => {
  assert.ok(Array.isArray(scorer.EPIC_LEVEL_TYPES));
  for (const t of scorer.EPIC_LEVEL_TYPES) assert.equal(t, t.toLowerCase());
  assert.ok(scorer.EPIC_LEVEL_TYPES.includes("epic"));
  assert.ok(scorer.EPIC_LEVEL_TYPES.includes("initiative"));
});

test("scoreItem throws NOT_EPIC_LEVEL for child types before hitting the provider", async () => {
  // No env set → if epic-level passes, getProvider() would throw a config
  // error. Since we use a child type, we should get NOT_EPIC_LEVEL first.
  await assert.rejects(
    () => scorer.scoreItem({ key: "X-1", type: "Story", summary: "s" }),
    err => err && err.code === "NOT_EPIC_LEVEL"
  );
});

test("scoreItem throws NO_PARENT_INITIATIVE on an Epic without a parent_key", async () => {
  await assert.rejects(
    () => scorer.scoreItem({ key: "X-1", type: "Epic", summary: "s" }),
    err => err && err.code === "NO_PARENT_INITIATIVE"
  );
});

test("scoreItem passes the epic+parent gate for an Initiative (no parent required)", async () => {
  // Initiative without parent should NOT throw at the gate — it should
  // proceed and only fail later at the provider config check.
  await assert.rejects(
    () => scorer.scoreItem({ key: "AFIINIT-1", type: "Initiative", summary: "s" }),
    err => err && err.code !== "NOT_EPIC_LEVEL" && err.code !== "NO_PARENT_INITIATIVE"
  );
});
