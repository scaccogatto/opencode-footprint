# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The `/co2` report (`co2_report` tool) is now computed from the session's full message history, read through the OpenCode SDK, instead of from events seen by the running process. Resumed sessions and sessions started before an OpenCode restart are now reported in full, and the report always matches the sidebar.
- Report duration now spans the session's first message to its last activity (it used to start at the first event the running process saw).
- `co2-tracker.ts` now uses OpenCode's V1 plugin module shape (`export default { id, server }`) and exports nothing else. The pure logic moved to `plugins/lib/co2-core.ts` and `plugins/lib/co2-report.ts`.
- Token counts in the report are always formatted with `en-US` digit grouping, independent of the host locale.
- Install flow: `INSTALL.md` now installs the latest tagged release (source archive of the tag) instead of downloading files from `main`, and takes dependency versions from that release's `.opencode/package.json`. Its shell snippet reports errors without exiting the agent's shell.
- Documented a single minimum host version: OpenCode 1.18.0.

### Fixed

- The server plugin no longer logs "failed to load plugin" at startup: OpenCode's legacy loader called every exported helper (`classifyModel` and others) as a plugin.
- Model classification matches whole id segments: the `mini` inside `gemini` no longer classifies Gemini Pro models as small, and provider-prefixed ids (`openai/o3-mini`, `anthropic/claude-opus-4-5`) are classified like bare ids.
- Dated and suffixed OpenAI reasoning minis (`o3-mini-2025-01-31`, `o4-mini-high`) are classified medium like `o3-mini` and `o4-mini`, instead of small.
- The "Minutes of a 10W LED bulb" equivalent is computed from energy, so it is now correct when `OPENCODE_CO2_GRID_INTENSITY` is set (it assumed 400 gCO2/kWh).
- A failed session history request is reported as an error instead of an empty report.
- The README example output now matches what the report actually prints.

## [0.2.0] - 2026-07-17

### Added

- TUI sidebar panel (`co2-sidebar.tsx`) showing session eco grade, CO2 and kWh, plus an all-time lifetime total persisted via `api.kv`.
- `export` argument on the `co2_report` tool: writes `co2-report.json` or `co2-report.md` to the project directory.
- `.opencode/tui.json` to register the sidebar plugin (TUI plugins are not auto-discovered).

## [0.1.0] - 2026-07-17

### Added

- `co2_report` tool and `/co2` command: eco report with session grade, per-model energy breakdown, CO2, real-world equivalents and tips.
- Per-model energy attribution with PUE, configurable grid intensity via `OPENCODE_CO2_GRID_INTENSITY`.

[Unreleased]: https://github.com/scaccogatto/opencode-footprint/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/scaccogatto/opencode-footprint/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/scaccogatto/opencode-footprint/releases/tag/v0.1.0
