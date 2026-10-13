# opencode-footprint

An [OpenCode](https://opencode.ai) plugin that tracks the CO2 carbon footprint of your coding sessions in real time. Get an eco report with a session grade, carbon footprint breakdown, real-world equivalents, and actionable tips to code greener.

## Features

- **Full-session tracking** -- the report is computed from the session's whole message history, so resumed sessions and OpenCode restarts are covered
- **Eco scoring** -- assigns a letter grade (A+ to F) based on CO2 efficiency per message
- **Real-world equivalents** -- translates grams of CO2 into Google searches, seconds of video streaming, smartphone charges, and more
- **Multi-model aware** -- tracks tokens per model and bills each model's tokens at its own size-based energy estimate, then sums across models used in the session
- **Configurable grid intensity** -- override the default 400 gCO2/kWh with your region's carbon intensity
- **Sidebar panel** -- session grade/CO2/kWh and an all-time total, always visible in the OpenCode TUI (see [Sidebar](#sidebar))
- **Report export** -- write the eco report to `co2-report.json` or `co2-report.md` in the project directory
- **Zero config** -- drop the files into your project and it works

## Requirements

OpenCode **1.18.0 or later** (needed for TUI slot plugins and V1 plugin modules). The plugin SDK and `@opentui/*` versions to install are the ones pinned in [`.opencode/package.json`](.opencode/package.json) of the release you install.

## Install

The quickest way to install is to let OpenCode do it for you. Humans can fail, so let AI handle it. Paste this link into your OpenCode prompt:

```
https://raw.githubusercontent.com/scaccogatto/opencode-footprint/main/INSTALL.md
```

The agent resolves the latest [release](https://github.com/scaccogatto/opencode-footprint/releases), downloads that tagged version (never unreleased code from `main`), sets up dependencies, and verifies the installation.

### Manual install

If you prefer to do it yourself:

```sh
# Clone the latest release (replace vX.Y.Z with the tag from the releases page)
git clone --depth 1 --branch vX.Y.Z https://github.com/scaccogatto/opencode-footprint.git

# Copy into your project
cp -r opencode-footprint/.opencode/plugins/ your-project/.opencode/plugins/
cp -r opencode-footprint/.opencode/commands/ your-project/.opencode/commands/
cp opencode-footprint/.opencode/tui.json your-project/.opencode/tui.json
```

The `tui.json` entry is what makes the [sidebar panel](#sidebar) load -- OpenCode does not auto-discover TUI plugins from `.opencode/plugins/`, unlike the server-side `co2_report` tool.

Then make sure the plugin SDK is installed: merge the `dependencies` block of the release's `.opencode/package.json` into your project's `.opencode/package.json` (create it if missing). Only `dependencies` are needed, not the dev dependencies or scripts.

OpenCode runs `bun install` automatically at startup, so dependencies will be resolved on the next launch. The `@opentui/*` and `solid-js` dependencies are only needed for the [sidebar panel](#sidebar); the `/co2` report tool works with just `@opencode-ai/plugin`.

## Usage

There are two ways to see your eco report:

### Slash command

Type `/co2` in the OpenCode TUI to generate your session's eco report.

### Natural language

Ask OpenCode about your session's carbon footprint, CO2 emissions, or environmental impact. The agent will call the `co2_report` tool automatically.

### Exporting the report

Ask OpenCode to export the report (or call the tool with `export: "json"` / `export: "markdown"`) to write it to the project directory:

- `export: "json"` -- writes `co2-report.json` (raw numbers, no formatting -- grade, tokens, energy, CO2, per-model breakdown, providers)
- `export: "markdown"` -- writes `co2-report.md` (the same report shown in the TUI)

The tool's text output always includes the eco report, plus the exported file's path when `export` is passed.

### Example output

```
## Eco Report | Your Coding Carbon Footprint

> **Session Grade: B-** -- Above Average
> Impact: `[████░░░░░░]`

---

### Session Overview

| Metric | Value |
|---|---|
| Duration | 8.3 min |
| Messages | 4 |
| Total tokens | 12,450 |
| API cost | $0.034000 |

### Per-Model Breakdown

| Model | Tokens | Energy |
|---|---|---|
| claude-sonnet-4-5 | 10,000 | 11.0000 Wh |
| claude-haiku-4-5 | 2,450 | 0.8085 Wh |

### Carbon Footprint

| Metric | Value |
|---|---|
| Energy consumed | 11.8085 Wh |
| **CO2 emitted** | **4.7234 g** |
| CO2 per message | 1.1809 g |
| Grid intensity | 400 gCO2/kWh |

### Real-World Equivalents

Your session's footprint is roughly equal to:

| Equivalent | Amount |
|---|---|
| Google searches | ~23.6 |
| Seconds of video streaming | ~472.3 |
| Smartphone charges | ~0.575 |
| Minutes of a 10W LED bulb | ~70.9 |
| km driven (EU avg car) | ~0.03904 |

### Token Breakdown

| Type | Count |
|---|---|
| Input | 6,100 |
| Output | 2,350 |
| Reasoning | 0 |
| Cache read | 3,000 |
| Cache write | 1,000 |

### Providers

- anthropic

---

> **Tip:** Not bad! Try batching questions to reduce message overhead.

*Estimates based on Luccioni et al. (2023). Actual values vary by hardware, data center, and region. Configure grid intensity with `OPENCODE_CO2_GRID_INTENSITY` env var.*
```

This example mixes a medium model (`claude-sonnet-4-5`) with a small one (`claude-haiku-4-5`) in the same session -- each model's tokens are billed at its own energy factor, and the per-model lines sum to the session total.

## Configuration

### Grid carbon intensity

The default grid intensity is **400 gCO2/kWh** (IEA global average). Override it with an environment variable to match your region:

```sh
# Example: France (~50 gCO2/kWh, mostly nuclear)
export OPENCODE_CO2_GRID_INTENSITY=50

# Example: Poland (~700 gCO2/kWh, coal-heavy)
export OPENCODE_CO2_GRID_INTENSITY=700
```

You can find your country's grid intensity at [Electricity Maps](https://app.electricitymaps.com).

## How it works

### Energy estimation

The plugin classifies each model into a size tier and applies an energy-per-token estimate based on published research:

| Model tier | Energy per token | Example models |
|------------|-----------------|----------------|
| Small      | 0.3 Wh / 1k tokens | Claude Haiku, GPT-4o Mini, Gemini Flash |
| Medium     | 1.0 Wh / 1k tokens | Claude Sonnet, GPT-4o, Gemini Pro |
| Large      | 3.0 Wh / 1k tokens | Claude Opus, o3 |

Tokens are tracked **per model** (keyed by `modelID`), not just per session. A
session that starts on a large model and switches to a small one bills each
model's tokens at that model's own rate, then sums the results -- instead of
billing every token in the session at a single "dominant" model's rate.
Input, output, reasoning, and cache read/write tokens are all counted toward
each model's billable total (cache tokens are billed at the same rate as a
simplification -- in reality cache reads are cheaper since they skip the
full forward pass, but there's no published per-token rate for them).

### CO2 calculation

```
per_model_energy (kWh) = model_tokens * energy_per_token * PUE
energy (kWh)            = sum(per_model_energy for each model used)
CO2 (grams)              = energy (kWh) * grid_intensity (gCO2/kWh)
```

`PUE` (Power Usage Effectiveness, ~1.1 for hyperscale data centers) scales
the raw compute energy up to account for cooling, power distribution, and
other data center overhead.

### Eco grade

The session grade is based on grams of CO2 per message:

| Grade | CO2/message | Label |
|-------|------------|-------|
| A+    | < 0.1g     | Exemplary |
| A     | < 0.3g     | Excellent |
| B     | < 0.8g     | Good |
| B-    | < 1.5g     | Above Average |
| C     | < 3.0g     | Moderate |
| D     | < 6.0g     | High Impact |
| F     | >= 6.0g    | Very High Impact |

### References

- Luccioni et al. "Power Hungry Processing: Watts Driving the Cost of AI Deployment?" (2023)
- IEA global average grid carbon intensity
- PUE ~1.1 for hyperscale data centers

## Sidebar

A TUI plugin (`.opencode/plugins/co2-sidebar.tsx`) renders the current session's eco grade and an all-time total in the session sidebar's footer:

```
B  1.18g CO2  0.0118 kWh
lifetime: 47.6 g
```

- Line 1: session eco grade, CO2 grams, and energy (kWh) for the open session -- recomputed reactively as messages stream in, from the same message history and the same `lib/co2-core.ts` math as the `/co2` report, so both always agree.
- Line 2: `lifetime: X g` -- an all-time CO2 total accumulated across every session, persisted via OpenCode's TUI key-value store (`api.kv`) so it survives restarts.

The sidebar needs the `tui.json` entry from the install step above -- OpenCode does not auto-discover TUI plugins from a directory, they must be listed explicitly.

**Note:** OpenCode's `sidebar_footer` slot is "single winner" -- only one registered plugin's content renders there, and this plugin always wins it (it's registered at a lower `order` than the built-in). That means the built-in footer (the getting-started hint / current path / OpenCode version) never shows once this plugin is installed, and the panel itself is blank until the session's first assistant reply -- there's no in-between state.

## Project structure

```
.opencode/
  plugins/
    co2-tracker.ts       # Server plugin: co2_report tool (default export only)
    co2-sidebar.tsx      # TUI plugin: sidebar_footer panel (default export, listed in tui.json)
    lib/
      co2-core.ts          # Pure CO2 model: classification, energy, grade, equivalents, lifetime totals
      co2-report.ts        # Pure report builder (markdown + JSON) over a session's message history
      co2-sidebar-logic.ts # Pure sidebar logic (session summary, formatting)
  commands/
    co2.md               # Slash command definition for /co2
  tui.json                # Registers co2-sidebar.tsx (TUI plugins are not auto-discovered)
  co2-tracker.test.ts     # Unit tests (node --test and bun test)
  bun.lock                # Dev lockfile (CI installs with --frozen-lockfile)
  package.json            # Plugin SDK + @opentui/solid-js dependencies, typecheck/test scripts
  tsconfig.json           # Typecheck config (incl. Solid JSX for the sidebar)
.github/
  workflows/
    ci.yml                # Typecheck + tests on Node 24 and Bun
```

The pure modules deliberately live under `plugins/lib/`, not directly in `plugins/`: OpenCode's server plugin loader auto-globs every top-level `.opencode/plugins/*.{ts,js}` file, and for a module without a V1 default export (`export default { id, server }`) it calls every export as if it were a server plugin. `co2-tracker.ts` therefore exports only its V1 default, and a unit test enforces that for every top-level plugin file.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE) -- Marco Boffo
