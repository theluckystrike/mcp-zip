# Installing mcp-zip (agent instructions)

This file tells an AI coding agent exactly how to install this MCP server. No account, no API key, no network service is required.

Server: **Zip archives** (@theluckystrike/mcp-zip)
What it does: Create zip archives from files or a directory tree with glob patterns, list what is inside one with its dangerous entries flagged (absolute paths, "..", symlinks, duplicate names, compression bombs), extract safely into a directory, add files to an existing archive, read one text entry without unpacking, and bundle a calendar month of the sibling servers' invoices, quotes and exports into one file. Entirely offline.
Source: https://github.com/theluckystrike/mcp-servers/tree/main/servers/zip
License: MIT. Support: support@zovo.one

## Status of the npm package

The npm package `@theluckystrike/mcp-zip` is not published yet. Until it is, the `npx` command below will fail with E404. Use **Alternative B - from source** further down, which is the supported path today, and keep the same client config with `"command": "node"` and the absolute path to `dist/index.js`.

## Prerequisites

- Node.js 18 or newer on PATH (`node --version`).
- No native build tools. The package is pure JavaScript.

## Step 1 - the run command

```sh
npx -y @theluckystrike/mcp-zip
```

The server speaks MCP over stdio. It prints one readiness line to stderr and nothing to stdout except protocol traffic. Do not run it interactively as a check; the client starts it.

## Step 2 - write the client config

### Claude Desktop

File: macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%\Claude\claude_desktop_config.json`.
Merge this entry into the existing `mcpServers` object; do not overwrite the file.

```json
{
  "mcpServers": {
    "zip": {
      "command": "npx",
      "args": ["-y", "@theluckystrike/mcp-zip"]
    }
  }
}
```

### Claude Code

```sh
claude mcp add zip -- npx -y @theluckystrike/mcp-zip
```

### Cursor

File: `.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` globally. Same JSON as Claude Desktop.

## Alternative B - from source

```sh
git clone https://github.com/theluckystrike/mcp-servers
cd mcp-servers
npm install
npm run build --workspace @theluckystrike/mcp-zip
```

Then point the client at the built entry point:

```json
{
  "mcpServers": {
    "zip": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-servers/servers/zip/dist/index.js"]
    }
  }
}
```

## Step 3 - optional Pro key

Set `MCP_LICENSE_KEY` in the server's `env` block, or call the `license_activate` tool once with the key. Free tier: 20 archives per calendar month, up to 25 MB and 200 entries each. Pro: no limit on any of the three. Reading an archive (`zip_list`, `zip_extract`, `zip_extract_text`) is never metered on either tier.

## Step 4 - verify

Restart the client and ask it to run `license_status`, then `zip_create` with `dir` set to a small folder and `out_path` set to a new `.zip` path, then `zip_list` on that file. A successful list ends with "Nothing suspicious". Nothing leaves the machine.

## Notes for the agent

- Data lives in `${XDG_DATA_HOME:-~/.local/share}/mcp-servers/zip/`. Deleting `archives.json` resets the register and this month's free count.
- `out_path` and `out_dir` are normal filesystem paths, not a sandbox. A directory given as `out_path`, a missing parent and an existing file without `overwrite: true` are each refused with a sentence, and nothing is written in those cases.
- Extraction refuses the whole archive if any selected entry is an absolute path, a traversal, a symlink or over the ratio ceiling. `skip_unsafe: true` extracts the rest and names what was left out; `dry_run: true` reports the plan and writes nothing.
- Zip passwords are not supported. Passing a `password` argument is refused rather than ignored, and an encrypted entry in someone else's archive is refused on read.
- ZIP64 archives (over 4 GB or over 65,535 entries) are refused by name; use the system `unzip` for those.
