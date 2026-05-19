# Data Model Decision: Duplicate Keys & Synthetic Items

**For:** Senior dev driving the SQLite import / data layer
**From:** App team
**Re:** Your `DATA_MODEL.md` analysis of the `UNIQUE constraint failed: review_items.key` import failure
**Status:** Decided. Ready to implement.

---

## Summary

Your analysis is solid and lands on the right answer (Option 2 / "prefer Epic over Story" via `ON CONFLICT`). We're going with a small refinement of that: **drop every item where `type === "Synthetic"` OR `parent_key` starts with `__` at import time.** That single filter resolves all 49 duplicate-key conflicts without needing schema changes, an `ON CONFLICT` clause, or "prefer Epic" logic.

We'll also add a guard test on our side asserting `seed.json` has no duplicate keys, so this issue can't regress silently. The seed-pipeline cleanup (the more architectural fix) is on our follow-up list but doesn't block your import.

One specific note: **Option 3 (composite primary key) wouldn't have worked for our data** even as a fallback. Detail in §3 below.

---

## 1. What we verified against the live seed

Before deciding, we audited `seed.json` to confirm the shape of the problem. The numbers:

| Metric | Value |
|---|---:|
| Total items in `seed.json` | 1,318 |
| Unique Jira keys | 1,255 |
| Duplicate key groups | 49 |
| Synthetic items (`type: "Synthetic"`, key starts with `__`) | 18 |
| Real-Jira-key duplicates | 47 |
| Cross-BU duplicates | 0 |
| Cross-project duplicates (different `project_key`) | 0 |

The "cross-project references" framing in your doc is one degree off the reality. Every duplicate sits **inside one BU and one project**. The pattern, for all 47 non-synthetic duplicates, is identical:

- **Copy A:** the real Epic. Has `child_evidence`, an AI verdict, a `parent_key` that's either empty or points at a real Initiative (`AFIINIT-31`, etc.).
- **Copy B:** a stub Story. `parent_key === "__CROSS_PROJECT__"`. Empty `child_evidence`. No real metadata.

Example — `ARA-402` in project `ARA`:

```text
Copy A: type=Epic, parent_key="",                 child_evidence="ARA-908 FOLD: ..."
Copy B: type=Story, parent_key="__CROSS_PROJECT__", child_evidence=""
```

Copy B exists because the source Daedalus scrub HTML rendered cross-project Epics under a synthetic `__CROSS_PROJECT__` heading for visual grouping. Our seed pipeline (`scripts/seed.js`) faithfully preserved both. That decision was reasonable at the time — the HTML's structure was the contract — but it's wrong for the database.

The synthetic items themselves (`__CROSS_PROJECT__` × 6, `__ORPHAN__` × 12) are also rendering artifacts — they exist to group Epics for display in the source HTML, not as real Jira data.

---

## 2. The chosen filter

> **Skip any item where `type === "Synthetic"` OR `parent_key.startsWith("__")` during import.**

This single rule:

- Drops 18 synthetic parents (`__CROSS_PROJECT__`, `__ORPHAN__`)
- Drops 47 stub-children whose only purpose was to appear under a synthetic parent
- Net loss: 65 of 1,318 items (4.9%)
- Net surviving: **1,253 items, every key unique**

Because every duplicate's Copy A (the real Epic) has an empty or real-Initiative `parent_key`, and every Copy B has `parent_key === "__CROSS_PROJECT__"`, the filter cleanly drops exactly the stubs and leaves the real records. We verified this by walking every duplicate key in the seed; none of the surviving records carries the AI scoring metadata of the stub instead of the Epic.

**No data is lost.** The real Epic record retains its `child_evidence`, `ai_verdict`, `ai_meta`, and parent-Initiative linkage. The synthetic parents' `child_evidence` field (which listed cross-project Epic keys) is the same information our app already computes at runtime from the real items' `parent_key` field, so dropping the synthetic summary doesn't lose anything the UI uses.

### Why this beats your Option 2 ("prefer Epic on conflict")

Option 2 works but is more clever than it needs to be. It requires:
- Running every `INSERT` even for items destined to be discarded
- An `ON CONFLICT(key) DO UPDATE SET … WHERE type='Epic' OR …` clause that the planner has to evaluate per row
- Ordering-independence reasoning ("what if Story is inserted first?")

The pre-filter approach does the same work in one pass at the app boundary. `ON CONFLICT` becomes a defensive belt-and-suspenders, not a load-bearing rule.

---

## 3. Why Option 3 (composite PK) wouldn't have worked

Your doc lists `PRIMARY KEY (key, project_key)` as a way to allow the same Jira key in different projects. It's the right idea for a different bug than ours.

For our data, **every duplicate is in the same project.** Both `ARA-402` rows have `project_key = "ARA"`. Both `DBA-669` rows have `project_key = "DBA"`. So under a `(key, project_key)` composite PK, the constraint violation would have been:

```text
UNIQUE constraint failed: review_items.key, review_items.project_key
```

…and the import would still fail. Option 3 is a no-op for our duplicate pattern. Worth ruling out explicitly so it doesn't get revisited.

(If we ever genuinely had cross-project Epic references — same Jira key meaningfully showing up in two distinct Jira projects — Option 3 would become the right tool. We don't see that in the seed today.)

---

## 4. Implementation sketch

Pseudocode for `import_seed_if_empty()`:

```rust
for bu in seed.business_units() {
    insert_bu(tx, bu).await?;
    for project in bu.projects() {
        insert_project(tx, project).await?;
        for item in project.items() {
            // SKIP SYNTHETIC PARENTS and STUB CHILDREN
            if item.jira().item_type() == "Synthetic"
               || item.jira().parent_key().starts_with("__") {
                continue;
            }
            sqlx::query(
                "INSERT INTO review_items (key, project_key, bu_slug, jira_data,
                                           ai_score, ai_verdict, current_verdict,
                                           override_decision, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
                 ON CONFLICT(key) DO UPDATE SET
                     jira_data = excluded.jira_data,
                     ai_score = excluded.ai_score,
                     ai_verdict = excluded.ai_verdict,
                     current_verdict = excluded.current_verdict,
                     override_decision = excluded.override_decision,
                     updated_at = datetime('now')"
            )
            .bind(item.key())
            .bind(project.key())
            .bind(bu.slug())
            // ...
            .execute(&mut *tx)
            .await?;
        }
    }
}
```

Keep the `ON CONFLICT` as a safety net even though the filter should make it dead code. Cheap, defensive, removes a class of "what if the seed changes?" anxiety.

---

## 5. What we'll do on our side

Two follow-ups land in our repo regardless of how you implement the import:

1. **Guard test** — `test/seed.test.js` will assert `seed.json` contains no duplicate keys after filtering synthetics and stubs. So if `scripts/seed.js` regresses and starts emitting duplicates of a new kind, we'll catch it before the import does.

2. **Seed-pipeline cleanup (deferred)** — the right architectural fix is for `scripts/seed.js` to never emit the synthetic items or stub children in the first place. We didn't do this tonight because (a) it's not blocking you and (b) you may want the import filter as a safety net even after the seed is clean. Tracking as a follow-up.

---

## 6. Open questions back to you

A few decisions you'll need to make on your side that we don't want to presume:

1. **Where does the filter actually live in your code?** A standalone `should_import(item) -> bool` predicate (testable in isolation) versus an inline `if` in the loop. We'd lean toward the predicate for testability but it's your call.

2. **Do you want item-type / parent-key as proper columns in the schema, or stay opaque inside `jira_data`?** Pulling them out makes the filter SQL-side and gives you cheap indexes on `type` and `parent_key`. Keeping them in the JSON blob is simpler but less queryable.

3. **Counts in the BU and project tables.** Your schema sketch has `business_units` and `projects` tables. Should their `item_count` columns be denormalized (computed at import, refreshed on writes) or always derived via `COUNT(*) GROUP BY`? Matters once decisions start flowing because the BU sidebar refreshes on every save.

4. **Anything you want from us before you build this out?** Happy to provide a cleaned-seed.json instead of asking you to filter at import time, if you'd rather the seed be canonical. Adds about an hour on our side.

---

## 7. Recap

- ✅ Decision: filter `type=Synthetic OR parent_key.startsWith("__")` at import time.
- ✅ Keep `ON CONFLICT DO UPDATE` as a defensive belt-and-suspenders.
- ✅ No schema change; `key` stays as the single primary key.
- ✅ We'll add a guard test asserting no duplicates in `seed.json`.
- 🚫 Option 3 (composite PK) doesn't apply — every duplicate is in the same project.
- 🕓 Seed-pipeline cleanup deferred; not blocking you.
- ❓ Three implementation questions for you above.

Ready when you are.
