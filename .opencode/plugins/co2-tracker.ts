import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { writeFile } from "node:fs/promises"
import path from "node:path"

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
// Tokens are tracked per model (see ModelTokens/SessionStats below) so a
// session that mixes small and large models bills each model's tokens at
// that model's own energy factor, then sums across models -- rather than
// billing every token in the session at one "dominant" model's rate.
// ---------------------------------------------------------------------------

// Power Usage Effectiveness for hyperscale data centers: total facility
// energy / IT equipment energy. Applied on top of the raw per-token energy
// estimate to account for cooling, power distribution, etc.
const PUE = 1.1

const MODEL_SIZE: Record<string, "small" | "medium" | "large"> = {
  // Anthropic
  "claude-haiku-4-5": "small",
  "claude-sonnet-4-5": "medium",
  "claude-sonnet-4": "medium",
  "claude-opus-4": "large",
  // OpenAI
  "gpt-4o-mini": "small",
  "gpt-4.1-mini": "small",
  "gpt-4.1-nano": "small",
  "gpt-4o": "medium",
  "gpt-4.1": "medium",
  "o3-mini": "medium",
  "o3": "large",
  "o4-mini": "medium",
  // Google
  "gemini-2.0-flash": "small",
  "gemini-2.5-flash": "small",
  "gemini-2.5-pro": "medium",
  // Fallback handled below
}

// kWh per single token (input+output averaged), by model class
const ENERGY_PER_TOKEN_KWH: Record<string, number> = {
  small: 0.0000003, //  0.3 Wh / 1k tokens
  medium: 0.000001, //  1.0 Wh / 1k tokens
  large: 0.000003, //  3.0 Wh / 1k tokens
}

// Default grid carbon intensity (gCO2 per kWh).
// Global average ≈ 400. Override with OPENCODE_CO2_GRID_INTENSITY.
const DEFAULT_GRID_INTENSITY = 400

export function getGridIntensity(): number {
  const env = process.env.OPENCODE_CO2_GRID_INTENSITY
  if (env) {
    const parsed = parseFloat(env)
    if (!isNaN(parsed) && parsed > 0) return parsed
  }
  return DEFAULT_GRID_INTENSITY
}

export function classifyModel(modelID: string): "small" | "medium" | "large" {
  // Try exact match first
  if (MODEL_SIZE[modelID]) return MODEL_SIZE[modelID]
  // Fuzzy match on substrings
  const id = modelID.toLowerCase()
  if (id.includes("haiku") || id.includes("mini") || id.includes("nano") || id.includes("flash"))
    return "small"
  if (id.includes("opus") || (id.includes("o3") && !id.includes("mini")))
    return "large"
  // Default to medium
  return "medium"
}

// ---------------------------------------------------------------------------
// Eco scoring -- assigns a letter grade based on CO2 per message
// ---------------------------------------------------------------------------

interface EcoGrade {
  grade: string
  label: string
  level: number // 1-10 impact level (lower = greener)
  tip: string
}

const ECO_THRESHOLDS: { maxPerMsg: number; grade: EcoGrade }[] = [
  {
    maxPerMsg: 0.1,
    grade: {
      grade: "A+",
      label: "Exemplary",
      level: 1,
      tip: "Your session is incredibly efficient. Keep it up!",
    },
  },
  {
    maxPerMsg: 0.3,
    grade: {
      grade: "A",
      label: "Excellent",
      level: 2,
      tip: "Great efficiency! Small models and focused prompts pay off.",
    },
  },
  {
    maxPerMsg: 0.8,
    grade: {
      grade: "B",
      label: "Good",
      level: 3,
      tip: "Solid session. Consider using smaller models for simpler tasks.",
    },
  },
  {
    maxPerMsg: 1.5,
    grade: {
      grade: "B-",
      label: "Above Average",
      level: 4,
      tip: "Not bad! Try batching questions to reduce message overhead.",
    },
  },
  {
    maxPerMsg: 3.0,
    grade: {
      grade: "C",
      label: "Moderate",
      level: 6,
      tip: "Consider using a smaller model for routine tasks to cut emissions.",
    },
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
  for (const t of ECO_THRESHOLDS) {
    if (perMsg <= t.maxPerMsg) return t.grade
  }
  return ECO_THRESHOLDS[ECO_THRESHOLDS.length - 1].grade
}

function impactBar(level: number): string {
  const max = 10
  const filled = Math.min(Math.max(level, 0), max)
  const empty = max - filled
  return "[" + "\u2588".repeat(filled) + "\u2591".repeat(empty) + "]"
}

// ---------------------------------------------------------------------------
// Per-session accumulator
// ---------------------------------------------------------------------------

export interface ModelTokens {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

function newModelTokens(): ModelTokens {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
}

interface SessionStats {
  tokensByModel: Map<string, ModelTokens>
  cost: number // USD from the provider
  messages: number
  providers: Set<string>
  firstSeen: number
}

function newSessionStats(): SessionStats {
  return {
    tokensByModel: new Map(),
    cost: 0,
    messages: 0,
    providers: new Set(),
    firstSeen: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// Energy / CO2 computation -- pure functions, exported for testing
// ---------------------------------------------------------------------------

export interface ModelEnergyBreakdown {
  modelID: string
  tokens: number
  energyKwh: number
}

// Total billable tokens for one model: input + output + reasoning + cache.
// ponytail: cache read/write tokens are billed at the same per-token factor
// as regular tokens -- a simplification. In reality cache reads are much
// cheaper (no full forward pass), but no published per-token rate exists
// for cache tokens specifically, so we fold them into the same estimate.
function billableTokens(tokens: ModelTokens): number {
  return (
    tokens.input +
    tokens.output +
    tokens.reasoning +
    tokens.cacheRead +
    tokens.cacheWrite
  )
}

// Per-model energy breakdown, with PUE already applied to each line so the
// lines sum exactly to the session total.
export function computeModelEnergyBreakdown(
  tokensByModel: Map<string, ModelTokens>,
): ModelEnergyBreakdown[] {
  return [...tokensByModel.entries()].map(([modelID, tokens]) => {
    const total = billableTokens(tokens)
    const energyPerToken = ENERGY_PER_TOKEN_KWH[classifyModel(modelID)]
    return { modelID, tokens: total, energyKwh: total * energyPerToken * PUE }
  })
}

export function sumEnergyKwh(breakdown: ModelEnergyBreakdown[]): number {
  return breakdown.reduce((sum, b) => sum + b.energyKwh, 0)
}

// ---------------------------------------------------------------------------
// Cross-session (lifetime) totals -- pure reducer over a persisted
// per-session map. TUI-side callers (e.g. the sidebar) persist this shape
// via api.kv; this file only owns the math so it stays testable.
// ---------------------------------------------------------------------------

export interface LifetimeSessionTotal {
  grams: number
  kwh: number
}

export type LifetimeSessions = Record<string, LifetimeSessionTotal>

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

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const CO2TrackerPlugin: Plugin = async ({ client }) => {
  // Map<sessionID, SessionStats>
  const sessions = new Map<string, SessionStats>()
  // Track the last-known token snapshot per message so we can compute
  // deltas on repeated `message.updated` events (tokens start at 0 and
  // get populated on later updates).
  const messageSnapshots = new Map<
    string,
    {
      input: number
      output: number
      reasoning: number
      cacheRead: number
      cacheWrite: number
      cost: number
    }
  >()

  await client.app.log({
    body: {
      service: "co2-tracker",
      level: "info",
      message: "CO2 tracker plugin initialized",
    },
  })

  function computeCO2(stats: SessionStats): {
    totalTokens: number
    energyKwh: number
    co2Grams: number
    breakdown: ModelEnergyBreakdown[]
  } {
    const gridIntensity = getGridIntensity()
    const breakdown = computeModelEnergyBreakdown(stats.tokensByModel)
    const totalTokens = breakdown.reduce((sum, b) => sum + b.tokens, 0)
    const energyKwh = sumEnergyKwh(breakdown)
    const co2Grams = energyKwh * gridIntensity

    return { totalTokens, energyKwh, co2Grams, breakdown }
  }

  function formatReport(stats: SessionStats): string {
    const { totalTokens, energyKwh, co2Grams, breakdown } = computeCO2(stats)
    const durationMin = (Date.now() - stats.firstSeen) / 60_000
    const grade = getEcoGrade(co2Grams, stats.messages)
    const co2PerMessage =
      stats.messages > 0 ? co2Grams / stats.messages : 0

    // Equivalences
    const googleSearches = co2Grams / 0.2 // ~0.2 gCO2 per search
    const phoneCharges = co2Grams / 8.22 // ~8.22 gCO2 per charge
    const videoStreamSec = co2Grams / 0.01 // ~36 gCO2/hr streaming
    const ledBulbMin = co2Grams / 0.0667 // 10W LED at 400 gCO2/kWh
    const kmDriven = co2Grams / 121 // EU avg car ~121 gCO2/km

    // Aggregate per-model token counts for the Token Breakdown table.
    const aggregated = [...stats.tokensByModel.values()].reduce(
      (sum, t) => ({
        input: sum.input + t.input,
        output: sum.output + t.output,
        reasoning: sum.reasoning + t.reasoning,
        cacheRead: sum.cacheRead + t.cacheRead,
        cacheWrite: sum.cacheWrite + t.cacheWrite,
      }),
      newModelTokens(),
    )

    const breakdownLines =
      breakdown.length > 0
        ? breakdown
            .map(
              (b) =>
                `| ${b.modelID} | ${b.tokens.toLocaleString()} | ${(b.energyKwh * 1000).toFixed(4)} Wh |`,
            )
            .join("\n")
        : "| None recorded | 0 | 0.0000 Wh |"
    const providerLines =
      [...stats.providers].length > 0
        ? [...stats.providers].map((p) => `- ${p}`).join("\n")
        : "- None recorded"

    const lines: string[] = [
      `## Eco Report | Your Coding Carbon Footprint`,
      ``,
      `> **Session Grade: ${grade.grade}** -- ${grade.label}`,
      `> Impact: \`${impactBar(grade.level)}\``,
      ``,
      `---`,
      ``,
      `### Session Overview`,
      ``,
      `| Metric | Value |`,
      `|---|---|`,
      `| Duration | ${durationMin.toFixed(1)} min |`,
      `| Messages | ${stats.messages} |`,
      `| Total tokens | ${totalTokens.toLocaleString()} |`,
      `| API cost | $${stats.cost.toFixed(6)} |`,
      ``,
      `### Per-Model Breakdown`,
      ``,
      `| Model | Tokens | Energy |`,
      `|---|---|---|`,
      breakdownLines,
      ``,
      `### Carbon Footprint`,
      ``,
      `| Metric | Value |`,
      `|---|---|`,
      `| Energy consumed | ${(energyKwh * 1000).toFixed(4)} Wh |`,
      `| **CO2 emitted** | **${co2Grams.toFixed(4)} g** |`,
      `| CO2 per message | ${co2PerMessage.toFixed(4)} g |`,
      `| Grid intensity | ${getGridIntensity()} gCO2/kWh |`,
      ``,
      `### Real-World Equivalents`,
      ``,
      `Your session's footprint is roughly equal to:`,
      ``,
      `| Equivalent | Amount |`,
      `|---|---|`,
      `| Google searches | ~${googleSearches.toFixed(1)} |`,
      `| Seconds of video streaming | ~${videoStreamSec.toFixed(1)} |`,
      `| Smartphone charges | ~${phoneCharges.toFixed(3)} |`,
      `| Minutes of a 10W LED bulb | ~${ledBulbMin.toFixed(1)} |`,
      `| km driven (EU avg car) | ~${kmDriven.toFixed(5)} |`,
      ``,
      `### Token Breakdown`,
      ``,
      `| Type | Count |`,
      `|---|---|`,
      `| Input | ${aggregated.input.toLocaleString()} |`,
      `| Output | ${aggregated.output.toLocaleString()} |`,
      `| Reasoning | ${aggregated.reasoning.toLocaleString()} |`,
      `| Cache read | ${aggregated.cacheRead.toLocaleString()} |`,
      `| Cache write | ${aggregated.cacheWrite.toLocaleString()} |`,
      ``,
      `### Providers`,
      ``,
      providerLines,
      ``,
      `---`,
      ``,
      `> **Tip:** ${grade.tip}`,
      ``,
      "*Estimates based on Luccioni et al. (2023). Actual values vary by hardware, data center, and region. " +
        "Configure grid intensity with `OPENCODE_CO2_GRID_INTENSITY` env var.*",
    ]
    return lines.join("\n")
  }

  // Raw-data counterpart to formatReport(), for the `export: "json"` tool
  // arg. Numbers stay unformatted (no toFixed/locale strings) -- that's the
  // JSON contract, callers format as they see fit.
  function buildReportData(stats: SessionStats) {
    const { totalTokens, energyKwh, co2Grams, breakdown } = computeCO2(stats)
    const grade = getEcoGrade(co2Grams, stats.messages)
    return {
      grade: grade.grade,
      label: grade.label,
      tip: grade.tip,
      durationMinutes: (Date.now() - stats.firstSeen) / 60_000,
      messages: stats.messages,
      totalTokens,
      costUsd: stats.cost,
      energyKwh,
      co2Grams,
      co2PerMessageGrams: stats.messages > 0 ? co2Grams / stats.messages : 0,
      gridIntensityGco2PerKwh: getGridIntensity(),
      breakdown,
      tokensByType: [...stats.tokensByModel.values()].reduce(
        (sum, t) => ({
          input: sum.input + t.input,
          output: sum.output + t.output,
          reasoning: sum.reasoning + t.reasoning,
          cacheRead: sum.cacheRead + t.cacheRead,
          cacheWrite: sum.cacheWrite + t.cacheWrite,
        }),
        newModelTokens(),
      ),
      providers: [...stats.providers],
    }
  }

  return {
    // ----- Event listener: track token usage from assistant messages -----
    event: async ({ event }) => {
      if (event.type === "message.updated") {
        const msg = event.properties.info
        if (msg.role !== "assistant") return

        const key = `${msg.sessionID}:${msg.id}`

        let stats = sessions.get(msg.sessionID)
        if (!stats) {
          stats = newSessionStats()
          sessions.set(msg.sessionID, stats)
        }

        // Compute deltas from the last snapshot so repeated updates
        // for the same message accumulate correctly.
        const prev = messageSnapshots.get(key) ?? {
          input: 0,
          output: 0,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
        }
        const isNew = !messageSnapshots.has(key)

        // Guard every field: an undefined token count must not poison totals.
        const input = msg.tokens?.input ?? 0
        const output = msg.tokens?.output ?? 0
        const reasoning = msg.tokens?.reasoning ?? 0
        const cacheRead = msg.tokens?.cache?.read ?? 0
        const cacheWrite = msg.tokens?.cache?.write ?? 0
        const cost = msg.cost ?? 0

        let modelTokens = stats.tokensByModel.get(msg.modelID)
        if (!modelTokens) {
          modelTokens = newModelTokens()
          stats.tokensByModel.set(msg.modelID, modelTokens)
        }
        modelTokens.input += input - prev.input
        modelTokens.output += output - prev.output
        modelTokens.reasoning += reasoning - prev.reasoning
        modelTokens.cacheRead += cacheRead - prev.cacheRead
        modelTokens.cacheWrite += cacheWrite - prev.cacheWrite

        stats.cost += cost - prev.cost
        if (isNew) stats.messages += 1
        stats.providers.add(msg.providerID)

        // Save the current snapshot for future delta calculations
        messageSnapshots.set(key, {
          input,
          output,
          reasoning,
          cacheRead,
          cacheWrite,
          cost,
        })
      }
    },

    // ----- Custom tool: co2_report -----
    tool: {
      co2_report: tool({
        description:
          "Shows the estimated CO2 carbon footprint of the current OpenCode session. " +
          "Generates an eco report with session grade (A+ to F), carbon footprint breakdown, " +
          "real-world equivalents, token usage, and actionable tips to code greener. " +
          "Call this tool when the user asks about CO2, carbon footprint, " +
          "environmental impact, or energy usage of their session. " +
          "Pass `export: \"json\"` or `export: \"markdown\"` to also write the report " +
          "to a co2-report file in the project directory.",
        args: {
          export: tool.schema
            .enum(["json", "markdown"])
            .optional()
            .describe("Also write the report to co2-report.<ext> in the project directory."),
        },
        async execute(args, context) {
          const stats = sessions.get(context.sessionID)
          if (!stats || stats.messages === 0) {
            return (
              "No usage data recorded yet for this session. " +
              "Start a conversation and check back -- your eco report will be waiting!"
            )
          }
          const report = formatReport(stats)
          if (!args.export) return report

          const ext = args.export === "json" ? "json" : "md"
          const content =
            args.export === "json" ? JSON.stringify(buildReportData(stats), null, 2) : report
          const filePath = path.join(context.directory, `co2-report.${ext}`)
          await writeFile(filePath, content, "utf8")
          return `${report}\n\n*Exported to \`${filePath}\`*`
        },
      }),
    },
  }
}
