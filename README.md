# Linjer

Linjer is a small, dependency-free Bun app for collecting text files, searching their lines, and exporting matches. It also has an optional viewer for a locally exported ChatGPT archive.

## Features

- Organize uploaded `.txt` and `.csv` files into collections.
- Search lines with substring, wildcard, or regular-expression matching.
- Export matching lines and revisit recent searches and exports.
- Search and download conversations from a ChatGPT archive when one is configured.

## Requirements

- [Bun](https://bun.sh/) installed.

## Run locally

```sh
bun run server.ts
```

Open <http://localhost:8787>. The server listens on port `8787` by default and binds to all network interfaces. On first run it creates a local `config.json`; change its `port` value to use a different port. It contains local port settings and is excluded from Git.

To run the existing helper script from Bash, use `./linjer.sh start`, `./linjer.sh status`, and `./linjer.sh stop`.

## Optional ChatGPT archive

Set `CHATGPT_ARCHIVE_DIR` to a ChatGPT archive-lite directory containing `summary.json` and conversation folders with `conversation.md` and `metadata.json` files. If unset, Linjer looks for `chatgpt-archive-lite` beside `server.ts`.

PowerShell:

```powershell
$env:CHATGPT_ARCHIVE_DIR = 'D:\path\to\ChatGPT-archive-lite'
bun run server.ts
```

Bash:

```sh
export CHATGPT_ARCHIVE_DIR="$HOME/path/to/ChatGPT-archive-lite"
bun run server.ts
```

## Network access and privacy

Linjer currently has no authentication. Anyone who can reach the server can use its API, including endpoints that upload or delete files and collections. Use it only on a trusted, private network. Do not expose it directly to the internet. A firewall may need to allow inbound connections to the selected port for other devices on your LAN.

Imported files, search history, exports, configuration, logs, and the optional archive are local runtime data and are excluded from Git.