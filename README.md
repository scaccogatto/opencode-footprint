# opencode-footprint

An [OpenCode](https://opencode.ai) plugin that tracks the CO2 carbon footprint of your coding sessions in real time. Get an eco report with a session grade, carbon footprint breakdown, real-world equivalents, and actionable tips to code greener.

## Features

- **Live tracking** -- automatically accumulates token usage across all messages in a session
- **Eco scoring** -- assigns a letter grade (A+ to F) based on CO2 efficiency per message
- **Real-world equivalents** -- translates grams of CO2 into Google searches, seconds of video streaming, smartphone charges, and more
- **Multi-model aware** -- supports Anthropic, OpenAI, and Google models with size-based energy estimates
- **Configurable grid intensity** -- override the default 400 gCO2/kWh with your region's carbon intensity
- **Zero config** -- drop the files into your project and it works

## Install

The quickest way to install is to let OpenCode do it for you. Paste this link into your OpenCode prompt:

```
https://raw.githubusercontent.com/scaccogatto/opencode-footprint/main/INSTALL.md
```

The agent will download the plugin files, set up dependencies, and verify the installation automatically.

### Manual install

If you prefer to do it yourself:

```sh
# Clone the repo
git clone https://github.com/scaccogatto/opencode-footprint.git

# Copy into your project
cp -r opencode-footprint/.opencode/plugins/ your-project/.opencode/plugins/
cp -r opencode-footprint/.opencode/commands/ your-project/.opencode/commands/
```

Then make sure the plugin SDK is installed. If your project doesn't already have a `.opencode/package.json`, create one:

```json
{
  "dependencies": {
    "@opencode-ai/plugin": "1.1.60"
  }
}
```

OpenCode runs `bun install` automatically at startup, so dependencies will be resolved on the next launch.

## Usage

There are two ways to see your eco report:

### Slash command

Type `/co2` in the OpenCode TUI to generate your session's eco report.

### Natural language

Ask OpenCode about your session's carbon footprint, CO2 emissions, or environmental impact. The agent will call the `co2_report` tool automatically.

### Example output

```
## Eco Report | Your Coding Carbon Footprint

> **Session Grade: A** -- Excellent
> Impact: `[██░░░░░░░░]`

---

### Session Overview

| Metric     | Value   |
|------------|---------|
| Duration   | 8.3 min |
| Messages   | 4       |
| Total tokens | 12,450 |
| API cost   | $0.034  |

### Carbon Footprint

| Metric          | Value       |
|-----------------|-------------|
| Energy consumed | 12.4500 Wh |
| **CO2 emitted** | **4.9800 g** |
| CO2 per message | 1.2450 g   |
| Grid intensity  | 400 gCO2/kWh |

### Real-World Equivalents

| Equivalent                  | Amount   |
|-----------------------------|----------|
| Google searches             | ~24.9    |
| Seconds of video streaming  | ~498.0   |
| Smartphone charges          | ~0.606   |
| Minutes of a 10W LED bulb   | ~74.7    |
| km driven (EU avg car)      | ~0.04116 |

> **Tip:** Great efficiency! Small models and focused prompts pay off.
```

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

### CO2 calculation

```
energy (kWh) = total_tokens * energy_per_token
CO2 (grams)  = energy (kWh) * grid_intensity (gCO2/kWh)
```

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

## Project structure

```
.opencode/
  plugins/
    co2-tracker.ts    # Core plugin: tracking, computation, and report formatting
  commands/
    co2.md            # Slash command definition for /co2
  package.json        # Plugin SDK dependency
```

## License

[MIT](LICENSE) -- Marco Boffo
