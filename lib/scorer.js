// LLM scorer for Jira items. Two providers, identical output schema.
//
// Provider chosen by SCORER_PROVIDER env var (anthropic | azure).
// System prompt = prompts/item-review.md (verbatim from the user's spec).
//
// Returns the JSON object defined in Section 7 of the prompt.

const fs = require("fs");
const path = require("path");

const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, "..", "prompts", "item-review.md"),
  "utf8"
);

const ALLOWED_VERDICTS = ["KEEP", "STOP", "FOLD", "FLAG"];

// JSON schema for structured output — mirrors Section 7 of the prompt.
const OUTPUT_SCHEMA = {
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
        properties: {
          q: { type: "string" },
          unlocks: { type: "string" }
        },
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

let anthropicClient = null;
let azureClient = null;

function getProvider() {
  const p = (process.env.SCORER_PROVIDER || "anthropic").toLowerCase();
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

function userMessage(item, buContext) {
  const payload = { item };
  if (buContext) payload.bu_context = buContext;
  return [
    "Score this single Jira item using the framework in the system prompt.",
    "Walk the gates in order. Return only the JSON object defined in Section 7.",
    "",
    "```json",
    JSON.stringify(payload, null, 2),
    "```"
  ].join("\n");
}

async function scoreWithAnthropic(item, buContext) {
  const client = getAnthropic();
  const model = process.env.ANTHROPIC_MODEL || "claude-opus-4-7";
  // Cache the system prompt — it's ~12k tokens and gets reused on every score.
  const resp = await client.messages.create({
    model,
    max_tokens: 4096,
    system: [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }
    ],
    messages: [{ role: "user", content: userMessage(item, buContext) }],
    output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } }
  });
  const textBlock = resp.content.find(b => b.type === "text");
  if (!textBlock) throw new Error("Anthropic returned no text block");
  return {
    parsed: JSON.parse(textBlock.text),
    raw_model: resp.model,
    usage: resp.usage
  };
}

async function scoreWithAzure(item, buContext) {
  const client = getAzure();
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  const resp = await client.chat.completions.create({
    model: deployment, // for Azure the model arg is the deployment name
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage(item, buContext) }
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "item_review", strict: true, schema: OUTPUT_SCHEMA }
    },
    max_tokens: 4096
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

function validate(out, fallbackKey) {
  if (!out || typeof out !== "object") throw new Error("Scorer returned non-object");
  if (!out.key) out.key = fallbackKey;
  if (!ALLOWED_VERDICTS.includes(out.verdict)) {
    throw new Error(`Invalid verdict from model: ${out.verdict}`);
  }
  if (out.verdict === "STOP" && out.gate !== 5) {
    // Re-walk: if Gate 1 fires under any reading, the framework says never STOP.
    // We don't have the field data to re-verify here, so flag it back to the caller.
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

async function scoreItem(item, buContext) {
  const provider = getProvider();
  const started = Date.now();
  let result;
  if (provider === "anthropic") result = await scoreWithAnthropic(item, buContext);
  else result = await scoreWithAzure(item, buContext);

  const parsed = validate(result.parsed, item.key);
  return {
    ...parsed,
    _meta: {
      provider,
      model: result.raw_model,
      scored_at: new Date().toISOString(),
      latency_ms: Date.now() - started,
      usage: result.usage || null
    }
  };
}

module.exports = { scoreItem, getProvider, ALLOWED_VERDICTS, SYSTEM_PROMPT_BYTES: SYSTEM_PROMPT.length };
