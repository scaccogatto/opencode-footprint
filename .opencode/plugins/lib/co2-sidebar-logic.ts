// Pure logic backing the TUI sidebar panel (co2-sidebar.tsx). Kept in its
// own plain .ts module -- no JSX -- so it can be unit tested directly; the
// component only renders precomputed strings from here.
//
// Lives under plugins/lib/, not directly in plugins/, on purpose: opencode's
// server plugin loader auto-globs every top-level `plugins/*.{ts,js}` file
// and calls each of its function-typed exports as `server(input, options)`.
// A one-level-deeper path is invisible to that (non-recursive) glob, so this
// helper module doesn't get misloaded as a server plugin.
import {
  computeModelEnergyBreakdown,
  getEcoGrade,
  sumEnergyKwh,
  type LifetimeSummary,
  type ModelTokens,
} from "../co2-tracker.ts"

function newModelTokens(): ModelTokens {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
}

function safeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

// `api.state.session.messages()` returns the host SDK's Message union
// (user | assistant), loosely typed here (mirroring the reference
// opencode-better-sidebar plugin's own convention) since only assistant
// messages carry token/model data and the exact discriminated shape is a
// host implementation detail we don't want to chase across SDK versions.
export function aggregateTokensByModel(messages: readonly any[]): Map<string, ModelTokens> {
  const byModel = new Map<string, ModelTokens>()
  for (const message of messages) {
    if (message?.role !== "assistant") continue
    const modelID: string = message?.modelID ?? "unknown"
    const tokens = byModel.get(modelID) ?? newModelTokens()
    tokens.input += safeNumber(message?.tokens?.input)
    tokens.output += safeNumber(message?.tokens?.output)
    tokens.reasoning += safeNumber(message?.tokens?.reasoning)
    tokens.cacheRead += safeNumber(message?.tokens?.cache?.read)
    tokens.cacheWrite += safeNumber(message?.tokens?.cache?.write)
    byModel.set(modelID, tokens)
  }
  return byModel
}

export interface SessionCo2Summary {
  grade: string
  co2Grams: number
  energyKwh: number
  messages: number
}

export function computeSessionCo2(
  messages: readonly any[],
  gridIntensityGco2PerKwh: number,
): SessionCo2Summary {
  const byModel = aggregateTokensByModel(messages)
  const breakdown = computeModelEnergyBreakdown(byModel)
  const energyKwh = sumEnergyKwh(breakdown)
  const co2Grams = energyKwh * gridIntensityGco2PerKwh
  const assistantMessages = messages.filter((m) => m?.role === "assistant").length
  const grade = getEcoGrade(co2Grams, assistantMessages)
  return { grade: grade.grade, co2Grams, energyKwh, messages: assistantMessages }
}

export function formatSessionLine(summary: SessionCo2Summary): string {
  return `${summary.grade}  ${summary.co2Grams.toFixed(2)}g CO2  ${summary.energyKwh.toFixed(4)} kWh`
}

export function formatLifetimeLine(lifetime: LifetimeSummary): string {
  return `lifetime: ${lifetime.grams.toFixed(1)} g`
}
