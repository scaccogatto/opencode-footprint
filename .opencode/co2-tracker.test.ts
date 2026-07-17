import { test } from "node:test"
import assert from "node:assert/strict"
import {
  classifyModel,
  getEcoGrade,
  computeModelEnergyBreakdown,
  sumEnergyKwh,
  type ModelTokens,
} from "./plugins/co2-tracker.ts"

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
