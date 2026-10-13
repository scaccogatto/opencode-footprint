// Pure eco-report builder for the `co2_report` tool. The server plugin
// fetches the session's full message history from the host and hands it
// here, so the report and the sidebar always agree (same history, same
// math) and the numbers survive OpenCode restarts and resumed sessions.
import {
  addModelTokens,
  aggregateTokensByModel,
  computeEquivalents,
  computeModelEnergyBreakdown,
  countAssistantMessages,
  emptyModelTokens,
  getEcoGrade,
  impactBar,
  safeNumber,
  sumEnergyKwh,
  type ModelEnergyBreakdown,
  type ModelTokens,
  type UsageMessage,
} from "./co2-core.ts"

export interface SessionStats {
  tokensByModel: ReadonlyMap<string, ModelTokens>
  costUsd: number // USD reported by the provider
  messages: number // assistant messages
  providers: readonly string[]
  durationMinutes: number // first message created -> last message activity
}

function messageTimes(message: UsageMessage): number[] {
  return [safeNumber(message.time?.created), safeNumber(message.time?.completed)].filter((t) => t > 0)
}

export function buildSessionStats(messages: readonly (UsageMessage | null | undefined)[]): SessionStats {
  const present = messages.filter((m): m is UsageMessage => m != null)
  const assistant = present.filter((m) => m.role === "assistant")
  const times = present.flatMap(messageTimes)
  const durationMs = times.length > 0 ? Math.max(...times) - Math.min(...times) : 0
  return {
    tokensByModel: aggregateTokensByModel(present),
    costUsd: assistant.reduce((sum, m) => sum + safeNumber(m.cost), 0),
    messages: countAssistantMessages(present),
    providers: [...new Set(assistant.flatMap((m) => (typeof m.providerID === "string" ? [m.providerID] : [])))],
    durationMinutes: durationMs / 60_000,
  }
}

export interface ReportData {
  grade: string
  label: string
  tip: string
  durationMinutes: number
  messages: number
  totalTokens: number
  costUsd: number
  energyKwh: number
  co2Grams: number
  co2PerMessageGrams: number
  gridIntensityGco2PerKwh: number
  breakdown: ModelEnergyBreakdown[]
  tokensByType: ModelTokens
  providers: string[]
}

// Raw-data report, also the `export: "json"` contract: numbers stay
// unformatted (no toFixed/locale strings), callers format as they see fit.
export function buildReportData(stats: SessionStats, gridIntensityGco2PerKwh: number): ReportData {
  const breakdown = computeModelEnergyBreakdown(stats.tokensByModel)
  const energyKwh = sumEnergyKwh(breakdown)
  const co2Grams = energyKwh * gridIntensityGco2PerKwh
  const grade = getEcoGrade(co2Grams, stats.messages)
  return {
    grade: grade.grade,
    label: grade.label,
    tip: grade.tip,
    durationMinutes: stats.durationMinutes,
    messages: stats.messages,
    totalTokens: breakdown.reduce((sum, b) => sum + b.tokens, 0),
    costUsd: stats.costUsd,
    energyKwh,
    co2Grams,
    co2PerMessageGrams: stats.messages > 0 ? co2Grams / stats.messages : 0,
    gridIntensityGco2PerKwh,
    breakdown,
    tokensByType: [...stats.tokensByModel.values()].reduce(addModelTokens, emptyModelTokens()),
    providers: [...stats.providers],
  }
}

export function formatReport(data: ReportData): string {
  const level = getEcoGrade(data.co2Grams, data.messages).level
  const eq = computeEquivalents(data.co2Grams, data.energyKwh)
  const t = data.tokensByType

  const breakdownLines =
    data.breakdown.length > 0
      ? data.breakdown
          .map((b) => `| ${b.modelID} | ${b.tokens.toLocaleString("en-US")} | ${(b.energyKwh * 1000).toFixed(4)} Wh |`)
          .join("\n")
      : "| None recorded | 0 | 0.0000 Wh |"
  const providerLines = data.providers.length > 0 ? data.providers.map((p) => `- ${p}`).join("\n") : "- None recorded"

  return [
    `## Eco Report | Your Coding Carbon Footprint`,
    ``,
    `> **Session Grade: ${data.grade}** -- ${data.label}`,
    `> Impact: \`${impactBar(level)}\``,
    ``,
    `---`,
    ``,
    `### Session Overview`,
    ``,
    `| Metric | Value |`,
    `|---|---|`,
    `| Duration | ${data.durationMinutes.toFixed(1)} min |`,
    `| Messages | ${data.messages} |`,
    `| Total tokens | ${data.totalTokens.toLocaleString("en-US")} |`,
    `| API cost | $${data.costUsd.toFixed(6)} |`,
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
    `| Energy consumed | ${(data.energyKwh * 1000).toFixed(4)} Wh |`,
    `| **CO2 emitted** | **${data.co2Grams.toFixed(4)} g** |`,
    `| CO2 per message | ${data.co2PerMessageGrams.toFixed(4)} g |`,
    `| Grid intensity | ${data.gridIntensityGco2PerKwh} gCO2/kWh |`,
    ``,
    `### Real-World Equivalents`,
    ``,
    `Your session's footprint is roughly equal to:`,
    ``,
    `| Equivalent | Amount |`,
    `|---|---|`,
    `| Google searches | ~${eq.googleSearches.toFixed(1)} |`,
    `| Seconds of video streaming | ~${eq.videoStreamSeconds.toFixed(1)} |`,
    `| Smartphone charges | ~${eq.phoneCharges.toFixed(3)} |`,
    `| Minutes of a 10W LED bulb | ~${eq.ledBulbMinutes.toFixed(1)} |`,
    `| km driven (EU avg car) | ~${eq.kmDriven.toFixed(5)} |`,
    ``,
    `### Token Breakdown`,
    ``,
    `| Type | Count |`,
    `|---|---|`,
    `| Input | ${t.input.toLocaleString("en-US")} |`,
    `| Output | ${t.output.toLocaleString("en-US")} |`,
    `| Reasoning | ${t.reasoning.toLocaleString("en-US")} |`,
    `| Cache read | ${t.cacheRead.toLocaleString("en-US")} |`,
    `| Cache write | ${t.cacheWrite.toLocaleString("en-US")} |`,
    ``,
    `### Providers`,
    ``,
    providerLines,
    ``,
    `---`,
    ``,
    `> **Tip:** ${data.tip}`,
    ``,
    "*Estimates based on Luccioni et al. (2023). Actual values vary by hardware, data center, and region. " +
      "Configure grid intensity with `OPENCODE_CO2_GRID_INTENSITY` env var.*",
  ].join("\n")
}
