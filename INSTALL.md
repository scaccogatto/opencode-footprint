---
description: Install the opencode-footprint CO2 tracker plugin
---
Install the opencode-footprint plugin into this project. Follow these steps exactly:

1. Create the `.opencode/plugins/`, `.opencode/plugins/lib/`, and `.opencode/commands/` directories if they don't exist.
2. Download the server plugin from `https://raw.githubusercontent.com/scaccogatto/opencode-footprint/main/.opencode/plugins/co2-tracker.ts` and save it to `.opencode/plugins/co2-tracker.ts`.
3. Download the sidebar plugin from `https://raw.githubusercontent.com/scaccogatto/opencode-footprint/main/.opencode/plugins/co2-sidebar.tsx` and save it to `.opencode/plugins/co2-sidebar.tsx`.
4. Download the sidebar logic module from `https://raw.githubusercontent.com/scaccogatto/opencode-footprint/main/.opencode/plugins/lib/co2-sidebar-logic.ts` and save it to `.opencode/plugins/lib/co2-sidebar-logic.ts`.
5. Download the command file from `https://raw.githubusercontent.com/scaccogatto/opencode-footprint/main/.opencode/commands/co2.md` and save it to `.opencode/commands/co2.md`.
6. Download `https://raw.githubusercontent.com/scaccogatto/opencode-footprint/main/.opencode/tui.json` and save it to `.opencode/tui.json`, merging with any existing `.opencode/tui.json` `plugin` array instead of overwriting it. This step registers the sidebar panel -- TUI plugins are not auto-discovered from `.opencode/plugins/`, unlike the server plugin.
7. If `.opencode/package.json` already exists, make sure it lists these dependencies (add whichever are missing): `@opencode-ai/plugin` (`1.18.3` or later), `@opentui/core` (`0.4.5` or later), `@opentui/solid` (`0.4.5` or later), `solid-js` (`1.9.12`). If `.opencode/package.json` doesn't exist, create it with:
   ```json
   {
     "dependencies": {
       "@opencode-ai/plugin": "1.18.3",
       "@opentui/core": "0.4.5",
       "@opentui/solid": "0.4.5",
       "solid-js": "1.9.12"
     }
   }
   ```
8. Run `bun install` inside `.opencode/` to install dependencies.
9. Confirm the installation was successful by listing the installed files.

Use `curl` for downloads. Do not clone the entire repository.
