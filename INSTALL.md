---
description: Install the opencode-footprint CO2 tracker plugin
---
Install the opencode-footprint plugin into this project from its latest tagged release. Never download files from the `main` branch. Follow these steps exactly, from the project root:

1. Resolve the latest release tag and download that release's source archive into a temporary directory:
   ```sh
   set -eu
   TAG=$(curl -fsSL https://api.github.com/repos/scaccogatto/opencode-footprint/releases/latest | sed -n 's/^ *"tag_name": *"\([^"]*\)".*/\1/p')
   case "$TAG" in v[0-9]*) ;; *) echo "could not resolve the latest release tag" >&2; exit 1 ;; esac
   SRC=$(mktemp -d)
   curl -fsSL "https://github.com/scaccogatto/opencode-footprint/archive/refs/tags/$TAG.tar.gz" | tar -xz -C "$SRC" --strip-components=1
   echo "Installing opencode-footprint $TAG from $SRC"
   ```
2. Copy the plugin files from the release into this project, overwriting older copies of the same files:
   ```sh
   mkdir -p .opencode/plugins .opencode/commands
   cp -R "$SRC/.opencode/plugins/." .opencode/plugins/
   cp "$SRC/.opencode/commands/co2.md" .opencode/commands/co2.md
   ```
3. Register the sidebar panel: if `.opencode/tui.json` does not exist, copy `$SRC/.opencode/tui.json` to it. If it exists, add `"./plugins/co2-sidebar.tsx"` to its `plugin` array (keep every existing entry). TUI plugins are not auto-discovered from `.opencode/plugins/`, unlike the server plugin.
4. Merge the `dependencies` object of `$SRC/.opencode/package.json` into `.opencode/package.json` (create the file with just that `dependencies` object if it doesn't exist). Use the release's exact versions for those packages. Do not copy its `devDependencies` or `scripts`.
5. Run `bun install` inside `.opencode/`.
6. Delete the temporary directory (`rm -rf "$SRC"`), then confirm the installation by listing the installed files and reporting the installed release tag. Remind the user that the plugin needs OpenCode 1.18.0 or later.
