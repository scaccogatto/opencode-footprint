// Server plugin: the `co2_report` tool.
//
// This file must export nothing but the V1 plugin module as its default
// export. OpenCode loads every top-level `plugins/*.{ts,js}` file, and a
// module without a V1 default export falls back to the legacy loader, which
// calls *every* export as a plugin. All pure logic therefore lives under
// plugins/lib/ (see co2-core.ts and co2-report.ts).
import type { PluginInput, PluginModule } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { getGridIntensity } from "./lib/co2-core.ts"
import { buildReportData, buildSessionStats, formatReport } from "./lib/co2-report.ts"

const NO_DATA_MESSAGE =
  "No usage data recorded yet for this session. " +
  "Start a conversation and check back -- your eco report will be waiting!"

// The report is rebuilt from the session's full message history on every
// call (the same source the sidebar reads), so it covers resumed sessions
// and messages sent before the current OpenCode process started.
const server = async ({ client }: PluginInput) => {
  await client.app.log({
    body: { service: "co2-tracker", level: "info", message: "CO2 tracker plugin initialized" },
  })

  return {
    tool: {
      co2_report: tool({
        description:
          "Shows the estimated CO2 carbon footprint of the current OpenCode session. " +
          "Generates an eco report with session grade (A+ to F), carbon footprint breakdown, " +
          "real-world equivalents, token usage, and actionable tips to code greener. " +
          "Call this tool when the user asks about CO2, carbon footprint, " +
          "environmental impact, or energy usage of their session. " +
          'Pass `export: "json"` or `export: "markdown"` to also write the report ' +
          "to a co2-report file in the project directory.",
        args: {
          export: tool.schema
            .enum(["json", "markdown"])
            .optional()
            .describe("Also write the report to co2-report.<ext> in the project directory."),
        },
        async execute(args, context) {
          const response = await client.session.messages({ path: { id: context.sessionID } })
          if (response.error !== undefined || response.data === undefined) {
            return `Could not read this session's messages: ${JSON.stringify(response.error ?? "empty response")}`
          }
          const stats = buildSessionStats(response.data.map((m) => m.info))
          if (stats.messages === 0) return NO_DATA_MESSAGE

          const data = buildReportData(stats, getGridIntensity())
          const report = formatReport(data)
          if (!args.export) return report

          const ext = args.export === "json" ? "json" : "md"
          const content = args.export === "json" ? JSON.stringify(data, null, 2) : report
          const filePath = path.join(context.directory, `co2-report.${ext}`)
          await writeFile(filePath, content, "utf8")
          return `${report}\n\n*Exported to \`${filePath}\`*`
        },
      }),
    },
  }
}

const plugin: PluginModule & { id: string } = {
  id: "opencode-footprint.co2-tracker",
  server,
}

export default plugin
