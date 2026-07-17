import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  classifyModel,
  getEcoGrade,
  computeModelEnergyBreakdown,
  sumEnergyKwh,
  upsertLifetimeSession,
  summarizeLifetime,
  CO2TrackerPlugin,
  type ModelTokens,
  type LifetimeSessions,
} from "./plugins/co2-tracker.ts"
import {
  aggregateTokensByModel,
  computeSessionCo2,
  formatSessionLine,
  formatLifetimeLine,
} from "./plugins/lib/co2-sidebar-logic.ts"

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

const PUE = 1.1 // mirrors the constant in co2-tracker.ts

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
// co2_report tool: export arg writes co2-report.<ext> and returns its path
// ---------------------------------------------------------------------------

test("co2_report tool: export writes co2-report.json and co2-report.md, both readable", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "co2-export-"))
  try {
    const hooks = await CO2TrackerPlugin({
      client: { app: { log: async () => {} } },
    } as any)

    await hooks.event!({
      event: {
        type: "message.updated",
        properties: {
          info: {
            role: "assistant",
            sessionID: "s1",
            id: "m1",
            modelID: "claude-sonnet-4-5",
            providerID: "anthropic",
            tokens: { input: 1000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } },
            cost: 0.01,
          },
        },
      },
    } as any)

    const context = { sessionID: "s1", directory: dir } as any

    const jsonOutput = (await hooks.tool!.co2_report.execute(
      { export: "json" },
      context,
    )) as string
    const jsonPath = path.join(dir, "co2-report.json")
    assert.ok(jsonOutput.includes(jsonPath))
    const parsed = JSON.parse(await readFile(jsonPath, "utf8"))
    assert.equal(parsed.messages, 1)
    assert.equal(parsed.totalTokens, 1500)
    assert.ok(parsed.co2Grams > 0)

    const mdOutput = (await hooks.tool!.co2_report.execute(
      { export: "markdown" },
      context,
    )) as string
    const mdPath = path.join(dir, "co2-report.md")
    assert.ok(mdOutput.includes(mdPath))
    const mdContent = await readFile(mdPath, "utf8")
    assert.ok(mdContent.includes("Eco Report"))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
