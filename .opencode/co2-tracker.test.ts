import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { PluginInput, ToolContext } from "@opencode-ai/plugin"
import co2TrackerPlugin from "./plugins/co2-tracker.ts"
import {
  aggregateTokensByModel,
  classifyModel,
  computeEquivalents,
  computeModelEnergyBreakdown,
  getEcoGrade,
  getGridIntensity,
  PUE,
  sumEnergyKwh,
  summarizeLifetime,
  upsertLifetimeSession,
  type LifetimeSessions,
  type ModelTokens,
  type UsageMessage,
} from "./plugins/lib/co2-core.ts"
import { buildReportData, buildSessionStats, formatReport } from "./plugins/lib/co2-report.ts"
import { computeSessionCo2, formatLifetimeLine, formatSessionLine } from "./plugins/lib/co2-sidebar-logic.ts"

// ---------------------------------------------------------------------------
// classifyModel
// ---------------------------------------------------------------------------

test("classifyModel: exact matches", () => {
  assert.equal(classifyModel("claude-haiku-4-5"), "small")
  assert.equal(classifyModel("claude-sonnet-4-5"), "medium")
  assert.equal(classifyModel("claude-opus-4"), "large")
})

test("classifyModel: fuzzy substring matches", () => {
  assert.equal(classifyModel("some-mini-model"), "small")
  assert.equal(classifyModel("some-nano-variant"), "small")
  assert.equal(classifyModel("gemini-flash-experimental"), "small")
  assert.equal(classifyModel("weird-opus-clone"), "large")
  assert.equal(classifyModel("acme-o3-preview"), "large")
  // Fuzzy "mini" substring wins over the fuzzy "o3" check, for models not
  // already covered by an exact MODEL_SIZE entry.
  assert.equal(classifyModel("acme-o3-mini-preview"), "small")
})

test("classifyModel: 'mini' inside 'gemini' is not a small-model marker", () => {
  assert.equal(classifyModel("gemini-3-pro-preview"), "medium")
  assert.equal(classifyModel("gemini-2.5-pro-preview-06-05"), "medium")
  assert.equal(classifyModel("google/gemini-2.5-pro"), "medium")
  assert.equal(classifyModel("gemini-2.5-flash-lite"), "small")
  assert.equal(classifyModel("gemini-3-flash-preview"), "small")
})

test("classifyModel: current Claude and GPT-5 ids, bare or provider-prefixed", () => {
  assert.equal(classifyModel("claude-opus-4-5"), "large")
  assert.equal(classifyModel("claude-opus-4-1-20250805"), "large")
  assert.equal(classifyModel("anthropic/claude-sonnet-4-5"), "medium")
  assert.equal(classifyModel("claude-haiku-4-5-20251001"), "small")
  assert.equal(classifyModel("anthropic.claude-opus-4-5-20251101-v1:0"), "large")
  assert.equal(classifyModel("gpt-5"), "medium")
  assert.equal(classifyModel("openai/gpt-5-mini"), "small")
  assert.equal(classifyModel("gpt-5-nano"), "small")
  assert.equal(classifyModel("openai/o3-mini"), "medium")
  assert.equal(classifyModel("Claude-Opus-4"), "large")
})

test("classifyModel: markers match whole segments, not substrings", () => {
  assert.equal(classifyModel("minimax-m2"), "medium")
  assert.equal(classifyModel("pro3-model"), "medium")
})

test("classifyModel: exact MODEL_SIZE entries win over fuzzy matching", () => {
  // "o3-mini" is an exact MODEL_SIZE entry (medium), even though it also
  // contains the fuzzy "mini" substring that would otherwise mean small.
  assert.equal(classifyModel("o3-mini"), "medium")
})

test("classifyModel: unknown model defaults to medium", () => {
  assert.equal(classifyModel("totally-unknown-model-xyz"), "medium")
})

// ---------------------------------------------------------------------------
// getEcoGrade boundaries
// ---------------------------------------------------------------------------

test("getEcoGrade: boundary values map to the correct grade", () => {
  assert.equal(getEcoGrade(0.1, 1).grade, "A+")
  assert.equal(getEcoGrade(0.100001, 1).grade, "A")
  assert.equal(getEcoGrade(0.3, 1).grade, "A")
  assert.equal(getEcoGrade(0.8, 1).grade, "B")
  assert.equal(getEcoGrade(1.5, 1).grade, "B-")
  assert.equal(getEcoGrade(3.0, 1).grade, "C")
  assert.equal(getEcoGrade(6.0, 1).grade, "D")
  assert.equal(getEcoGrade(6.000001, 1).grade, "F")
  assert.equal(getEcoGrade(1_000_000, 1).grade, "F")
})

test("getEcoGrade: zero messages does not divide by zero", () => {
  const grade = getEcoGrade(5, 0)
  assert.equal(grade.grade, "A+") // perMsg falls back to 0
})

// ---------------------------------------------------------------------------
// Per-model energy summation
// ---------------------------------------------------------------------------

test("computeModelEnergyBreakdown + sumEnergyKwh: weighted total across models", () => {
  const tokensByModel = new Map<string, ModelTokens>([
    [
      "claude-haiku-4-5", // small: 0.0000003 kWh/token
      { input: 1000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    ],
    [
      "claude-opus-4", // large: 0.000003 kWh/token
      { input: 1000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    ],
  ])

  const breakdown = computeModelEnergyBreakdown(tokensByModel)
  assert.equal(breakdown.length, 2)

  const haiku = breakdown.find((b) => b.modelID === "claude-haiku-4-5")!
  const opus = breakdown.find((b) => b.modelID === "claude-opus-4")!
  assert.equal(haiku.tokens, 1000)
  assert.equal(opus.tokens, 1000)

  const expectedHaikuEnergy = 1000 * 0.0000003 * PUE
  const expectedOpusEnergy = 1000 * 0.000003 * PUE
  assert.ok(Math.abs(haiku.energyKwh - expectedHaikuEnergy) < 1e-12)
  assert.ok(Math.abs(opus.energyKwh - expectedOpusEnergy) < 1e-12)

  const total = sumEnergyKwh(breakdown)
  const expectedTotal = expectedHaikuEnergy + expectedOpusEnergy
  assert.ok(Math.abs(total - expectedTotal) < 1e-12)
  // A large model must contribute far more per token than a small one.
  assert.ok(opus.energyKwh > haiku.energyKwh * 5)
})

test("computeModelEnergyBreakdown: includes cache read/write tokens", () => {
  const tokensByModel = new Map<string, ModelTokens>([
    [
      "claude-sonnet-4-5", // medium: 0.000001 kWh/token
      { input: 0, output: 0, reasoning: 0, cacheRead: 500, cacheWrite: 500 },
    ],
  ])
  const [entry] = computeModelEnergyBreakdown(tokensByModel)
  assert.equal(entry.tokens, 1000)
  const expected = 1000 * 0.000001 * PUE
  assert.ok(Math.abs(entry.energyKwh - expected) < 1e-12)
})

test("computeModelEnergyBreakdown: empty map yields zero energy, no NaN", () => {
  const breakdown = computeModelEnergyBreakdown(new Map())
  assert.equal(breakdown.length, 0)
  const total = sumEnergyKwh(breakdown)
  assert.equal(total, 0)
  assert.ok(!Number.isNaN(total))
})

// ---------------------------------------------------------------------------
// Lifetime totals reducer (upsertLifetimeSession / summarizeLifetime)
// ---------------------------------------------------------------------------

test("upsertLifetimeSession: adds a new session entry", () => {
  const sessions = upsertLifetimeSession({}, "s1", { grams: 5, kwh: 0.01 })
  assert.deepEqual(sessions, { s1: { grams: 5, kwh: 0.01 } })
})

test("upsertLifetimeSession: overwrites (not adds to) an existing session's entry", () => {
  const sessions: LifetimeSessions = { s1: { grams: 5, kwh: 0.01 } }
  const updated = upsertLifetimeSession(sessions, "s1", { grams: 9, kwh: 0.02 })
  assert.deepEqual(updated, { s1: { grams: 9, kwh: 0.02 } })
  // Original object is untouched (pure function).
  assert.deepEqual(sessions, { s1: { grams: 5, kwh: 0.01 } })
})

test("upsertLifetimeSession: repeated upserts of the same running total are idempotent", () => {
  let sessions: LifetimeSessions = {}
  sessions = upsertLifetimeSession(sessions, "s1", { grams: 3, kwh: 0.001 })
  sessions = upsertLifetimeSession(sessions, "s1", { grams: 3, kwh: 0.001 })
  sessions = upsertLifetimeSession(sessions, "s1", { grams: 3, kwh: 0.001 })
  assert.deepEqual(summarizeLifetime(sessions), { grams: 3, kwh: 0.001, sessions: 1 })
})

test("summarizeLifetime: sums grams/kwh across sessions and counts them", () => {
  const sessions: LifetimeSessions = {
    s1: { grams: 5, kwh: 0.01 },
    s2: { grams: 2.5, kwh: 0.005 },
  }
  assert.deepEqual(summarizeLifetime(sessions), { grams: 7.5, kwh: 0.015, sessions: 2 })
})

test("summarizeLifetime: empty map yields all-zero summary, no NaN", () => {
  const summary = summarizeLifetime({})
  assert.deepEqual(summary, { grams: 0, kwh: 0, sessions: 0 })
})

// ---------------------------------------------------------------------------
// Sidebar logic: aggregateTokensByModel / computeSessionCo2 / formatting
// ---------------------------------------------------------------------------

test("aggregateTokensByModel: sums tokens per model across assistant messages, ignores others", () => {
  const messages = [
    { role: "user", modelID: "claude-sonnet-4-5", tokens: { input: 999 } },
    {
      role: "assistant",
      modelID: "claude-sonnet-4-5",
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 10, write: 5 } },
    },
    {
      role: "assistant",
      modelID: "claude-sonnet-4-5",
      tokens: { input: 200, output: 25 },
    },
    {
      role: "assistant",
      modelID: "claude-haiku-4-5",
      tokens: { input: 1000 },
    },
  ]

  const byModel = aggregateTokensByModel(messages)
  assert.equal(byModel.size, 2)
  assert.deepEqual(byModel.get("claude-sonnet-4-5"), {
    input: 300,
    output: 75,
    reasoning: 0,
    cacheRead: 10,
    cacheWrite: 5,
  })
  assert.deepEqual(byModel.get("claude-haiku-4-5"), {
    input: 1000,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  })
})

test("aggregateTokensByModel: missing/malformed token fields default to 0, no NaN", () => {
  const messages = [
    { role: "assistant", modelID: "unknown-model" },
    { role: "assistant", tokens: { input: "not-a-number" } },
  ]
  const byModel = aggregateTokensByModel(messages)
  for (const tokens of byModel.values()) {
    for (const value of Object.values(tokens)) {
      assert.ok(!Number.isNaN(value))
    }
  }
})

test("computeSessionCo2: derives grade/energy/co2 for a session's messages", () => {
  const messages = [
    { role: "assistant", modelID: "claude-opus-4", tokens: { input: 2000, output: 1000 } },
  ]
  const summary = computeSessionCo2(messages, 400)
  assert.equal(summary.messages, 1)
  const expectedEnergyKwh = 3000 * 0.000003 * 1.1
  assert.ok(Math.abs(summary.energyKwh - expectedEnergyKwh) < 1e-12)
  assert.ok(Math.abs(summary.co2Grams - expectedEnergyKwh * 400) < 1e-9)
  assert.equal(summary.grade, getEcoGrade(summary.co2Grams, 1).grade)
})

test("computeSessionCo2: no assistant messages yields zero footprint, no NaN", () => {
  const summary = computeSessionCo2([], 400)
  assert.deepEqual(summary, { grade: "A+", co2Grams: 0, energyKwh: 0, messages: 0 })
})

test("formatSessionLine / formatLifetimeLine: render the expected one-line strings", () => {
  const line = formatSessionLine({ grade: "B", co2Grams: 1.234, energyKwh: 0.05678, messages: 3 })
  assert.equal(line, "B  1.23g CO2  0.0568 kWh")

  const lifetime = formatLifetimeLine({ grams: 42.05, kwh: 1.2, sessions: 7 })
  assert.equal(lifetime, "lifetime: 42.0 g")
})

// ---------------------------------------------------------------------------
// Grid intensity and real-world equivalents
// ---------------------------------------------------------------------------

test("getGridIntensity: env override, rejects invalid values", () => {
  assert.equal(getGridIntensity({}), 400)
  assert.equal(getGridIntensity({ OPENCODE_CO2_GRID_INTENSITY: "50" }), 50)
  assert.equal(getGridIntensity({ OPENCODE_CO2_GRID_INTENSITY: "-3" }), 400)
  assert.equal(getGridIntensity({ OPENCODE_CO2_GRID_INTENSITY: "abc" }), 400)
  assert.equal(getGridIntensity({ OPENCODE_CO2_GRID_INTENSITY: "Infinity" }), 400)
})

test("computeEquivalents: LED bulb minutes depend on energy, not on grid intensity", () => {
  const energyKwh = 0.01 // 10 Wh = one hour of a 10W bulb
  const at400 = computeEquivalents(energyKwh * 400, energyKwh)
  const at50 = computeEquivalents(energyKwh * 50, energyKwh)
  assert.ok(Math.abs(at400.ledBulbMinutes - 60) < 1e-9)
  assert.ok(Math.abs(at50.ledBulbMinutes - 60) < 1e-9)
  // CO2-denominated equivalents do scale with the grid.
  assert.ok(Math.abs(at400.googleSearches / at50.googleSearches - 8) < 1e-9)
})

// ---------------------------------------------------------------------------
// Report building from the session's message history
// ---------------------------------------------------------------------------

const history: UsageMessage[] = [
  { role: "user", time: { created: 1_000_000 } },
  {
    role: "assistant",
    modelID: "claude-sonnet-4-5",
    providerID: "anthropic",
    cost: 0.02,
    tokens: { input: 8000, output: 2000, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1_010_000, completed: 1_060_000 },
  },
  { role: "user", time: { created: 1_100_000 } },
  {
    role: "assistant",
    modelID: "claude-haiku-4-5",
    providerID: "anthropic",
    cost: 0.004,
    tokens: { input: 2000, output: 450, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1_110_000, completed: 1_120_000 },
  },
  {
    role: "assistant",
    modelID: "gpt-5",
    providerID: "openai",
    cost: 0.01,
    tokens: { input: 1000, output: 500, reasoning: 500, cache: { read: 1000, write: 0 } },
    time: { created: 1_130_000 },
  },
]

test("buildSessionStats: per-model tokens, cost, providers and duration from history", () => {
  const stats = buildSessionStats(history)
  assert.equal(stats.messages, 3)
  assert.ok(Math.abs(stats.costUsd - 0.034) < 1e-12)
  assert.deepEqual(stats.providers, ["anthropic", "openai"])
  // First message created (1_000_000) to last activity (1_130_000).
  assert.ok(Math.abs(stats.durationMinutes - 130_000 / 60_000) < 1e-12)
  assert.deepEqual(stats.tokensByModel.get("gpt-5"), {
    input: 1000,
    output: 500,
    reasoning: 500,
    cacheRead: 1000,
    cacheWrite: 0,
  })
})

test("buildSessionStats: empty or malformed history yields zeros, no NaN", () => {
  const stats = buildSessionStats([null, undefined, { role: "assistant", cost: "x", time: { created: "y" } }])
  assert.equal(stats.messages, 1)
  assert.equal(stats.costUsd, 0)
  assert.equal(stats.durationMinutes, 0)
  assert.deepEqual(stats.providers, [])
})

test("buildReportData + formatReport: consistent numbers across JSON and markdown", () => {
  const data = buildReportData(buildSessionStats(history), 400)
  assert.equal(data.totalTokens, 15450)
  assert.deepEqual(data.tokensByType, { input: 11000, output: 2950, reasoning: 500, cacheRead: 1000, cacheWrite: 0 })
  const report = formatReport(data)
  assert.ok(report.includes(`**Session Grade: ${data.grade}**`))
  assert.ok(report.includes("| Total tokens | 15,450 |"))
  assert.ok(report.includes("| API cost | $0.034000 |"))
  assert.ok(report.includes(`| **CO2 emitted** | **${data.co2Grams.toFixed(4)} g** |`))
  assert.ok(report.includes("Your session's footprint is roughly equal to:"))
  assert.ok(report.includes("### Token Breakdown"))
  assert.ok(report.includes("- anthropic\n- openai"))
})

// ---------------------------------------------------------------------------
// Loader contract: OpenCode globs top-level plugins/*.{ts,js} and, unless a
// module default exports a V1 plugin object, calls every export as a plugin.
// ---------------------------------------------------------------------------

test("every top-level server plugin file exports only a V1 default { id, server }", async () => {
  const pluginsDir = path.join(import.meta.dirname, "plugins")
  const files = (await readdir(pluginsDir, { withFileTypes: true }))
    .filter((e) => e.isFile() && /\.(ts|js)$/.test(e.name))
    .map((e) => e.name)
  assert.ok(files.includes("co2-tracker.ts"))
  for (const file of files) {
    const mod: Record<string, unknown> = await import(pathToFileURL(path.join(pluginsDir, file)).href)
    assert.deepEqual(Object.keys(mod), ["default"], `${file} must export only a default`)
    const plugin = mod.default as Record<string, unknown>
    assert.equal(typeof plugin.id, "string", `${file} default export needs a string id`)
    assert.ok((plugin.id as string).trim().length > 0)
    assert.equal(typeof plugin.server, "function", `${file} default export needs server()`)
    assert.equal(plugin.tui, undefined, `${file} must not export both server() and tui()`)
  }
})

// ---------------------------------------------------------------------------
// co2_report tool: built from the host's message history via the SDK client
// ---------------------------------------------------------------------------

type MessagesResponse = { data?: { info: UsageMessage }[]; error?: unknown }

async function loadTool(messages: () => MessagesResponse) {
  const requested: string[] = []
  const client = {
    app: { log: async () => ({}) },
    session: {
      messages: async (options: { path: { id: string } }) => {
        requested.push(options.path.id)
        return messages()
      },
    },
  }
  const hooks = await co2TrackerPlugin.server({ client } as unknown as PluginInput)
  const tool = hooks.tool?.co2_report
  assert.ok(tool)
  return { tool, requested }
}

function toolContext(sessionID: string, directory: string): ToolContext {
  return { sessionID, directory } as unknown as ToolContext
}

async function run(tool: Awaited<ReturnType<typeof loadTool>>["tool"], args: { export?: "json" | "markdown" }, ctx: ToolContext) {
  const output = await tool.execute(args, ctx)
  return typeof output === "string" ? output : output.output
}

test("co2_report tool: reports a resumed session's full history without any live events", async () => {
  const { tool, requested } = await loadTool(() => ({ data: history.map((info) => ({ info })) }))
  const output = await run(tool, {}, toolContext("s-resumed", "/unused"))
  assert.deepEqual(requested, ["s-resumed"])
  assert.ok(output.includes("| Messages | 3 |"))
  assert.ok(output.includes("| Total tokens | 15,450 |"))
  assert.ok(output.includes("| API cost | $0.034000 |"))
  assert.ok(output.includes("| claude-haiku-4-5 | 2,450 |"))
  assert.ok(output.includes("| gpt-5 | 3,000 |"))
})

test("co2_report tool: re-reads history on every call (streamed updates are never double-counted)", async () => {
  const snapshots: UsageMessage[][] = [
    [{ role: "assistant", modelID: "claude-sonnet-4-5", tokens: { input: 100 }, cost: 0.001 }],
    [{ role: "assistant", modelID: "claude-sonnet-4-5", tokens: { input: 100, output: 50 }, cost: 0.002 }],
    [{ role: "assistant", modelID: "claude-sonnet-4-5", tokens: { input: 100, output: 400 }, cost: 0.005 }],
  ]
  let call = 0
  const { tool } = await loadTool(() => ({ data: snapshots[call++].map((info) => ({ info })) }))
  const ctx = toolContext("s1", "/unused")
  await run(tool, {}, ctx)
  await run(tool, {}, ctx)
  const output = await run(tool, {}, ctx)
  assert.ok(output.includes("| Messages | 1 |"))
  assert.ok(output.includes("| Total tokens | 500 |"))
  assert.ok(output.includes("| API cost | $0.005000 |"))
})

test("co2_report tool: no assistant messages yet", async () => {
  const { tool } = await loadTool(() => ({ data: [{ info: { role: "user" } }] }))
  const output = await run(tool, {}, toolContext("s1", "/unused"))
  assert.ok(output.startsWith("No usage data recorded yet"))
})

test("co2_report tool: surfaces a failed history request instead of an empty report", async () => {
  const { tool } = await loadTool(() => ({ error: { name: "NotFoundError" } }))
  const output = await run(tool, {}, toolContext("missing", "/unused"))
  assert.ok(output.startsWith("Could not read this session's messages"))
  assert.ok(output.includes("NotFoundError"))
})

test("co2_report tool: export writes co2-report.json and co2-report.md, both readable", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "co2-export-"))
  try {
    const { tool } = await loadTool(() => ({
      data: [
        {
          info: {
            role: "assistant",
            modelID: "claude-sonnet-4-5",
            providerID: "anthropic",
            tokens: { input: 1000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } },
            cost: 0.01,
          },
        },
      ],
    }))
    const ctx = toolContext("s1", dir)

    const jsonOutput = await run(tool, { export: "json" }, ctx)
    const jsonPath = path.join(dir, "co2-report.json")
    assert.ok(jsonOutput.includes(jsonPath))
    const parsed = JSON.parse(await readFile(jsonPath, "utf8"))
    assert.equal(parsed.messages, 1)
    assert.equal(parsed.totalTokens, 1500)
    assert.equal(parsed.costUsd, 0.01)
    assert.ok(parsed.co2Grams > 0)

    const mdOutput = await run(tool, { export: "markdown" }, ctx)
    const mdPath = path.join(dir, "co2-report.md")
    assert.ok(mdOutput.includes(mdPath))
    const mdContent = await readFile(mdPath, "utf8")
    assert.ok(mdContent.includes("Eco Report"))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
