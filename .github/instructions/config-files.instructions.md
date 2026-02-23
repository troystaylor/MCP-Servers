---
name: 'Config Files'
description: 'Conventions for configuration files like package.json and tsconfig.json'
applyTo: '**/{package.json,tsconfig.json,.prettierrc*}'
---

# Config File Conventions

- Each MCP server is a standalone project in its own directory at the workspace root.
- Use pnpm as the package manager. Never use npm or yarn.
- Include `"type": "module"` in every package.json.
- Keep dependencies minimal — only add what the server actually uses.
- Pin `@modelcontextprotocol/server` to a specific version or `latest` — avoid `*` or unversioned ranges.
