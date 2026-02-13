---
description: Install the opencode-footprint CO2 tracker plugin
---
Install the opencode-footprint plugin into this project. Follow these steps exactly:

1. Create the `.opencode/plugins/` and `.opencode/commands/` directories if they don't exist.
2. Download the plugin file from `https://raw.githubusercontent.com/scaccogatto/opencode-footprint/main/.opencode/plugins/co2-tracker.ts` and save it to `.opencode/plugins/co2-tracker.ts`.
3. Download the command file from `https://raw.githubusercontent.com/scaccogatto/opencode-footprint/main/.opencode/commands/co2.md` and save it to `.opencode/commands/co2.md`.
4. If `.opencode/package.json` already exists, make sure `@opencode-ai/plugin` is listed as a dependency (version `1.1.60` or later). If it doesn't exist, create it with `{ "dependencies": { "@opencode-ai/plugin": "1.1.60" } }`.
5. Run `bun install` inside `.opencode/` to install dependencies.
6. Confirm the installation was successful by listing the installed files.

Use `curl` for downloads. Do not clone the entire repository.
