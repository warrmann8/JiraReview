// LLM scorer for Jira Epics. Two providers, identical output schema.
//
// Provider chosen by SCORER_PROVIDER env var (anthropic | azure).
// System prompt = prompts/item-review.md (Daedalus item-review framework).
//
// Scoring is restricted to Epic / Initiative items — children roll up under
// their parent Epic as evidence and are not scored independently.

const fs = require("fs");
const path = require("path");

const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, "..", "prompts", "item-review.md"),
  "utf8"
);

const ALLOWED_VERDICTS = ["KEEP", "STOP", "FOLD", "FLAG"];
const EPIC_LEVEL_TYPES = new Set(["epic", "initiative"]);

function isEpicLevel(type) {
  if (!type) return false;
  return EPIC_LEVEL_TYPES.has(String(type).toLowerCase().trim());
}

// Full schema — single-item form, deep-dive view.
const FULL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    key: { type: "string" },
    verdict: { type: "string", enum: ALLOWED_VERDICTS },
    gate: { type: ["integer", "null"], enum: [1, 2, 3, 4, 5, null] },
    reason: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    tentative_verdict: { type: ["string", "null"], enum: ["KEEP", "STOP", "FOLD", null] },
    rationale: { type: "string" },
    dependencies: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: { type: "string" },
          ref: { type: "string" },
          note: { type: "string" }
        },
        required: ["type", "ref", "note"]
      }
    },
    needs_to_resolve: { type: "array", items: { type: "string" } },
    questions_for_human: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { q: { type: "string" }, unlocks: { type: "string" } },
        required: ["q", "unlocks"]
      }
    },
    harvest: {
      type: "object",
      additionalProperties: false,
      properties: {
        applies: { type: "boolean" },
        target: { type: "string" },
        note: { type: "string" }
      },
      required: ["applies", "target", "note"]
    },
    effort_estimate: { type: "string", enum: ["small", "medium", "large", "unknown"] },
    staleness_days: { type: ["integer", "null"] },
    notes: { type: "string" }
  },
  required: [
    "key", "verdict", "gate", "reason", "confidence", "tentative_verdict",
    "rationale", "dependencies", "needs_to_resolve", "questions_for_human",
    "harvest", "effort_estimate", "staleness_days", "notes"
  ]
};

// Lite schema — bulk path. ~60% fewer output tokens. Just the fields needed
// to render a row in the table and a basic FOLD harvest target.
const LITE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    key: { type: "string" },
    verdict: { type: "string", enum: ALLOWED_VERDICTS },
    gate: { type: ["integer", "null"], enum: [1, 2, 3, 4, 5, null] },
    reason: { type: "string" },
    harvest_target: { type: "string" }
  },
  required: ["key", "verdict", "gate", "reason", "harvest_target"]
};

let anthropicClient = null;
let azureClient = null;

function getProvider() {
  const p = (process.env.SCORER_PROVIDER || "azure").toLowerCase();
  if (p !== "anthropic" && p !== "azure") {
    throw new Error(`Unknown SCORER_PROVIDER: ${p}. Use 'anthropic' or 'azure'.`);
  }
  return p;
}

function getAnthropic() {
  if (anthropicClient) return anthropicClient;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not set in environment.");
  }
  const Anthropic = require("@anthropic-ai/sdk").default || require("@anthropic-ai/sdk");
  anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropicClient;
}

function getAzure() {
  if (azureClient) return azureClient;
  const { AzureOpenAI } = require("openai");
  if (!process.env.AZURE_OPENAI_ENDPOINT || !process.env.AZURE_OPENAI_API_KEY || !process.env.AZURE_OPENAI_DEPLOYMENT) {
    throw new Error("Azure OpenAI is not fully configured. Set AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, and AZURE_OPENAI_DEPLOYMENT.");
  }
  azureClient = new AzureOpenAI({
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    apiKey: process.env.AZURE_OPENAI_API_KEY,
    apiVersion: process.env.AZURE_OPENAI_API_VERSION || "2024-10-21",
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT
  });
  return azureClient;
}

function userMessage(item, buContext, mode) {
  const payload = { mode, item };
  if (buContext) payload.bu_context = buContext;
  return [
    `Score this Jira Epic using the framework in the system prompt. Mode: ${mode}.`,
    mode === "lite"
      ? "Return only key, verdict, gate, reason, and harvest_target (empty string when not FOLD)."
      : "Return only the JSON object defined in Section 7.",
    "",
    "```json",
    JSON.stringify(payload, null, 2),
    "```"
  ].join("\n");
}

async function scoreWithAnthropic(item, buContext, mode) {
  const client = getAnthropic();
  const model = process.env.ANTHROPIC_MODEL || "claude-opus-4-7";
  const schema = mode === "lite" ? LITE_SCHEMA : FULL_SCHEMA;
  const resp = await client.messages.create({
    model,
    max_tokens: mode === "lite" ? 1024 : 4096,
    system: [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }
    ],
    messages: [{ role: "user", content: userMessage(item, buContext, mode) }],
    output_config: { format: { type: "json_schema", schema } }
  });
  const textBlock = resp.content.find(b => b.type === "text");
  if (!textBlock) throw new Error("Anthropic returned no text block");
  return {
    parsed: JSON.parse(textBlock.text),
    raw_model: resp.model,
    usage: resp.usage
  };
}

async function scoreWithAzure(item, buContext, mode) {
  const client = getAzure();
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  const schema = mode === "lite" ? LITE_SCHEMA : FULL_SCHEMA;
  const resp = await client.chat.completions.create({
    model: deployment,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage(item, buContext, mode) }
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "item_review", strict: true, schema }
    },
    max_tokens: mode === "lite" ? 1024 : 4096
  });
  const choice = resp.choices && resp.choices[0];
  if (!choice || !choice.message || !choice.message.content) {
    throw new Error("Azure OpenAI returned no content");
  }
  return {
    parsed: JSON.parse(choice.message.content),
    raw_model: resp.model || deployment,
    usage: resp.usage
  };
}

function validate(out, fallbackKey, mode) {
  if (!out || typeof out !== "object") throw new Error("Scorer returned non-object");
  if (!out.key) out.key = fallbackKey;
  if (!ALLOWED_VERDICTS.includes(out.verdict)) {
    throw new Error(`Invalid verdict from model: ${out.verdict}`);
  }
  if (mode === "lite") return out;

  // Full-mode invariants.
  if (out.verdict === "STOP" && out.gate !== 5) {
    out.notes = (out.notes ? out.notes + " " : "") +
      "[validator] STOP returned without Gate 5 citation; verify Gate 1 manually.";
  }
  if (out.verdict === "FOLD" && !(out.harvest && out.harvest.applies === true)) {
    out.harvest = { applies: true, target: out.harvest?.target || "", note: out.harvest?.note || "" };
  }
  if (out.verdict !== "FOLD" && out.harvest?.applies === true) {
    out.harvest.applies = false;
  }
  return out;
}

async function scoreItem(item, buContext, opts = {}) {
  const mode = opts.mode === "lite" ? "lite" : "full";
  if (!isEpicLevel(item.type)) {
    const err = new Error(`Scoring is Epic-level only. Item ${item.key} has type "${item.type || "<unset>"}". Score the parent Epic instead.`);
    err.code = "NOT_EPIC_LEVEL";
    throw err;
  }
  // Epics must link to a parent Initiative. Initiatives themselves are top-level
  // and exempt — they are the parent.
  const typeLower = String(item.type).toLowerCase();
  if (typeLower === "epic" && !item.parent_key) {
    const err = new Error(`Epic ${item.key} has no parent_key. Every Epic must be linked to its parent Initiative.`);
    err.code = "NO_PARENT_INITIATIVE";
    throw err;
  }
  const provider = getProvider();
  const started = Date.now();
  let result;
  if (provider === "anthropic") result = await scoreWithAnthropic(item, buContext, mode);
  else result = await scoreWithAzure(item, buContext, mode);

  const parsed = validate(result.parsed, item.key, mode);
  return {
    ...parsed,
    _meta: {
      provider,
      model: result.raw_model,
      mode,
      scored_at: new Date().toISOString(),
      latency_ms: Date.now() - started,
      usage: result.usage || null
    }
  };
}

module.exports = {
  scoreItem,
  getProvider,
  isEpicLevel,
  EPIC_LEVEL_TYPES: Array.from(EPIC_LEVEL_TYPES),
  ALLOWED_VERDICTS,
  SYSTEM_PROMPT_BYTES: SYSTEM_PROMPT.length
};
