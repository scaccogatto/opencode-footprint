// Pure logic backing the TUI sidebar panel (co2-sidebar.tsx). Kept in its
// own plain .ts module (no JSX) so it can be unit tested directly. The
// component only renders precomputed strings from here.
//
// Lives under plugins/lib/ for the same reason as co2-core.ts: OpenCode's
// server plugin loader globs only the top level of plugins/.
import {
  aggregateTokensByModel,
  computeModelEnergyBreakdown,
  countAssistantMessages,
  getEcoGrade,
  sumEnergyKwh,
  type LifetimeSummary,
  type UsageMessage,
} from "./co2-core.ts"

export interface SessionCo2Summary {
  grade: string
  co2Grams: number
  energyKwh: number
  messages: number
}

export function computeSessionCo2(
  messages: readonly (UsageMessage | null | undefined)[],
  gridIntensityGco2PerKwh: number,
): SessionCo2Summary {
  const energyKwh = sumEnergyKwh(computeModelEnergyBreakdown(aggregateTokensByModel(messages)))
  const co2Grams = energyKwh * gridIntensityGco2PerKwh
  const assistantMessages = countAssistantMessages(messages)
  const grade = getEcoGrade(co2Grams, assistantMessages)
  return { grade: grade.grade, co2Grams, energyKwh, messages: assistantMessages }
}

export function formatSessionLine(summary: SessionCo2Summary): string {
  return `${summary.grade}  ${summary.co2Grams.toFixed(2)}g CO2  ${summary.energyKwh.toFixed(4)} kWh`
}

export function formatLifetimeLine(lifetime: LifetimeSummary): string {
  return `lifetime: ${lifetime.grams.toFixed(1)} g`
}
