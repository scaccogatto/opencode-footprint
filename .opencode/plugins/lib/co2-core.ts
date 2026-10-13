// Pure CO2 model shared by the server plugin (co2-tracker.ts), the TUI
// sidebar (co2-sidebar.tsx) and the unit tests.
//
// Lives under plugins/lib/, not directly in plugins/, on purpose: OpenCode's
// server plugin loader auto-globs every top-level `plugins/*.{ts,js}` file
// and, for a module without a V1 default export, calls each of its exports
// as `server(input, options)`. A one-level-deeper path is invisible to that
// (non-recursive) glob, so these helpers never get misloaded as plugins.
//
// ---------------------------------------------------------------------------
// CO2 emission model
// ---------------------------------------------------------------------------
// Energy estimates (kWh per token) based on published research:
//   - Luccioni et al. "Power Hungry Processing" (2023)
//   - IEA global average grid carbon intensity: ~400 gCO2/kWh
//   - PUE ~1.1 for hyperscale data centers
//
// These are rough estimates. Real values depend on hardware, data center
// location, cooling, and model architecture. Users can override the grid
// carbon intensity via the OPENCODE_CO2_GRID_INTENSITY env var.
//
// Tokens are tracked per model so a session that mixes small and large
// models bills each model's tokens at that model's own energy factor, then
// sums across models, rather than billing every token in the session at one
// "dominant" model's rate.
// ---------------------------------------------------------------------------

export type ModelSize = "small" | "medium" | "large"

// Power Usage Effectiveness for hyperscale data centers: total facility
// energy / IT equipment energy. Applied on top of the raw per-token energy
// estimate to account for cooling, power distribution, etc.
export const PUE = 1.1

// Exact-match exceptions to the token rules in classifyModel(). Only models
// whose family markers would classify them wrongly need an entry here.
const MODEL_SIZE: Readonly<Record<string, ModelSize>> = {
  // OpenAI reasoning minis are mid-sized despite the "mini" marker.
  "o3-mini": "medium",
  "o4-mini": "medium",
}

// Family markers, matched against whole id segments (never substrings: the
// "mini" in "gemini" must not make every Gemini model small).
const SMALL_MARKERS: ReadonlySet<string> = new Set(["haiku", "mini", "nano", "flash", "lite"])
const LARGE_MARKERS: ReadonlySet<string> = new Set(["opus", "o3"])

// kWh per single token (input+output averaged), by model class
export const ENERGY_PER_TOKEN_KWH: Readonly<Record<ModelSize, number>> = {
  small: 0.0000003, //  0.3 Wh / 1k tokens
  medium: 0.000001, //  1.0 Wh / 1k tokens
  large: 0.000003, //  3.0 Wh / 1k tokens
}

// Default grid carbon intensity (gCO2 per kWh).
// Global average ≈ 400. Override with OPENCODE_CO2_GRID_INTENSITY.
export const DEFAULT_GRID_INTENSITY = 400

export function getGridIntensity(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OPENCODE_CO2_GRID_INTENSITY
  if (raw) {
    const parsed = parseFloat(raw)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return DEFAULT_GRID_INTENSITY
}

// Model ids arrive in many shapes: bare ("claude-opus-4-5"), provider
// prefixed ("openrouter/google/gemini-2.5-pro"), or vendor qualified
// ("anthropic.claude-haiku-4-5-20251001-v1:0"). Keep the last path segment
// for the exact table, and split everything on separators for markers.
export function classifyModel(modelID: string): ModelSize {
  const id = modelID.toLowerCase()
  const name = id.slice(id.lastIndexOf("/") + 1)
  const exact = MODEL_SIZE[name]
  if (exact) return exact
  const segments = id.split(/[-/._:@\s]+/)
  if (segments.some((s) => SMALL_MARKERS.has(s))) return "small"
  if (segments.some((s) => LARGE_MARKERS.has(s))) return "large"
  return "medium"
}

// ---------------------------------------------------------------------------
// Eco scoring: assigns a letter grade based on CO2 per message
// ---------------------------------------------------------------------------

export interface EcoGrade {
  grade: string
  label: string
  level: number // 1-10 impact level (lower = greener)
  tip: string
}

const ECO_THRESHOLDS: readonly { maxPerMsg: number; grade: EcoGrade }[] = [
  {
    maxPerMsg: 0.1,
    grade: { grade: "A+", label: "Exemplary", level: 1, tip: "Your session is incredibly efficient. Keep it up!" },
  },
  {
    maxPerMsg: 0.3,
    grade: { grade: "A", label: "Excellent", level: 2, tip: "Great efficiency! Small models and focused prompts pay off." },
  },
  {
    maxPerMsg: 0.8,
    grade: { grade: "B", label: "Good", level: 3, tip: "Solid session. Consider using smaller models for simpler tasks." },
  },
  {
    maxPerMsg: 1.5,
    grade: { grade: "B-", label: "Above Average", level: 4, tip: "Not bad! Try batching questions to reduce message overhead." },
  },
  {
    maxPerMsg: 3.0,
    grade: { grade: "C", label: "Moderate", level: 6, tip: "Consider using a smaller model for routine tasks to cut emissions." },
  },
  {
    maxPerMsg: 6.0,
    grade: {
      grade: "D",
      label: "High Impact",
      level: 8,
      tip: "This session is carbon-heavy. Smaller models can reduce your footprint by up to 10x.",
    },
  },
  {
    maxPerMsg: Infinity,
    grade: {
      grade: "F",
      label: "Very High Impact",
      level: 10,
      tip: "Consider breaking work into smaller sessions and using efficient models.",
    },
  },
]

export function getEcoGrade(co2Grams: number, messages: number): EcoGrade {
  const perMsg = messages > 0 ? co2Grams / messages : 0
  return (ECO_THRESHOLDS.find((t) => perMsg <= t.maxPerMsg) ?? ECO_THRESHOLDS[ECO_THRESHOLDS.length - 1]).grade
}

export function impactBar(level: number): string {
  const max = 10
  const filled = Math.min(Math.max(level, 0), max)
  return "[" + "█".repeat(filled) + "░".repeat(max - filled) + "]"
}

// ---------------------------------------------------------------------------
// Token aggregation over the host's message history
// ---------------------------------------------------------------------------

export interface ModelTokens {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export function emptyModelTokens(): ModelTokens {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
}

export function addModelTokens(a: ModelTokens, b: ModelTokens): ModelTokens {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  }
}

// Structural view of the host SDK's Message union (user | assistant). Every
// field is optional and `unknown`, so both the typed SDK messages and
// partially populated (streaming or malformed) records are accepted, and
// every value is validated before use.
export interface UsageMessage {
  role?: unknown
  modelID?: unknown
  providerID?: unknown
  cost?: unknown
  tokens?: {
    input?: unknown
    output?: unknown
    reasoning?: unknown
    cache?: { read?: unknown; write?: unknown }
  }
  time?: { created?: unknown; completed?: unknown }
}

export function safeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function isAssistant(message: UsageMessage | null | undefined): message is UsageMessage {
  return message?.role === "assistant"
}

function messageTokens(message: UsageMessage): ModelTokens {
  return {
    input: safeNumber(message.tokens?.input),
    output: safeNumber(message.tokens?.output),
    reasoning: safeNumber(message.tokens?.reasoning),
    cacheRead: safeNumber(message.tokens?.cache?.read),
    cacheWrite: safeNumber(message.tokens?.cache?.write),
  }
}

export function aggregateTokensByModel(messages: readonly (UsageMessage | null | undefined)[]): Map<string, ModelTokens> {
  return messages.filter(isAssistant).reduce((byModel, message) => {
    const modelID = typeof message.modelID === "string" ? message.modelID : "unknown"
    return byModel.set(modelID, addModelTokens(byModel.get(modelID) ?? emptyModelTokens(), messageTokens(message)))
  }, new Map<string, ModelTokens>())
}

export function countAssistantMessages(messages: readonly (UsageMessage | null | undefined)[]): number {
  return messages.filter(isAssistant).length
}

// ---------------------------------------------------------------------------
// Energy / CO2 computation
// ---------------------------------------------------------------------------

export interface ModelEnergyBreakdown {
  modelID: string
  tokens: number
  energyKwh: number
}

// Total billable tokens for one model: input + output + reasoning + cache.
// Cache read/write tokens are billed at the same per-token factor as
// regular tokens, a simplification: in reality cache reads are much cheaper
// (no full forward pass), but no published per-token rate exists for cache
// tokens specifically, so we fold them into the same estimate.
function billableTokens(tokens: ModelTokens): number {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite
}

// Per-model energy breakdown, with PUE already applied to each line so the
// lines sum exactly to the session total.
export function computeModelEnergyBreakdown(tokensByModel: ReadonlyMap<string, ModelTokens>): ModelEnergyBreakdown[] {
  return [...tokensByModel.entries()].map(([modelID, tokens]) => {
    const total = billableTokens(tokens)
    return { modelID, tokens: total, energyKwh: total * ENERGY_PER_TOKEN_KWH[classifyModel(modelID)] * PUE }
  })
}

export function sumEnergyKwh(breakdown: readonly ModelEnergyBreakdown[]): number {
  return breakdown.reduce((sum, b) => sum + b.energyKwh, 0)
}

// ---------------------------------------------------------------------------
// Real-world equivalents
// ---------------------------------------------------------------------------

export interface Equivalents {
  googleSearches: number
  videoStreamSeconds: number
  phoneCharges: number
  ledBulbMinutes: number
  kmDriven: number
}

// A 10W LED bulb draws 10 Wh per hour, i.e. 10/60 Wh per minute.
const LED_BULB_WH_PER_MINUTE = 10 / 60

// CO2-denominated equivalents scale with the grid intensity. The LED bulb
// runs on the same grid as the data center, so it is compared in energy
// terms: that keeps it correct for any OPENCODE_CO2_GRID_INTENSITY.
export function computeEquivalents(co2Grams: number, energyKwh: number): Equivalents {
  return {
    googleSearches: co2Grams / 0.2, // ~0.2 gCO2 per search
    videoStreamSeconds: co2Grams / 0.01, // ~36 gCO2/hr streaming
    phoneCharges: co2Grams / 8.22, // ~8.22 gCO2 per charge
    ledBulbMinutes: (energyKwh * 1000) / LED_BULB_WH_PER_MINUTE,
    kmDriven: co2Grams / 121, // EU avg car ~121 gCO2/km
  }
}

// ---------------------------------------------------------------------------
// Cross-session (lifetime) totals: pure reducer over a persisted
// per-session map. TUI-side callers (the sidebar) persist this shape via
// api.kv. This module only owns the math so it stays testable.
// ---------------------------------------------------------------------------

export interface LifetimeSessionTotal {
  grams: number
  kwh: number
}

export type LifetimeSessions = Readonly<Record<string, LifetimeSessionTotal>>

// Overwrites (not adds to) this session's entry with its current running
// total. Idempotent by design: re-renders, TUI restarts, and replayed
// message events all recompute the same session total from scratch, so
// upserting instead of accumulating deltas means a session can never be
// double-counted into the lifetime sum.
export function upsertLifetimeSession(
  sessions: LifetimeSessions,
  sessionID: string,
  total: LifetimeSessionTotal,
): LifetimeSessions {
  return { ...sessions, [sessionID]: total }
}

export interface LifetimeSummary {
  grams: number
  kwh: number
  sessions: number
}

export function summarizeLifetime(sessions: LifetimeSessions): LifetimeSummary {
  const totals = Object.values(sessions)
  return {
    grams: totals.reduce((sum, t) => sum + t.grams, 0),
    kwh: totals.reduce((sum, t) => sum + t.kwh, 0),
    sessions: totals.length,
  }
}
