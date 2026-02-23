---
description: Add a new tool to an existing MCP server
agent: agent
tools:
  - editFiles
  - search
  - readFile
---

# Add a Tool to an MCP Server

Add a new tool registration to an existing MCP server in this workspace.

## Requirements

- Ask the user for:
  - **Which server** (directory name) to add the tool to
  - **Tool name** (e.g. `get-data`, `search-items`)
  - **Description** of what the tool does
  - **Input parameters** the tool should accept

## Implementation Pattern

Use the `server.registerTool()` pattern from the TypeScript SDK:

```typescript
server.registerTool(
  '<tool-name>',
  {
    title: '<Human-Readable Title>',
    description: '<Description of what the tool does>',
    inputSchema: z.object({
      // Define parameters using Zod schemas
      param: z.string().describe('Description of the parameter'),
    }),
  },
  async ({ param }) => {
    // Tool implementation
    return {
      content: [{
        type: 'text' as const,
        text: 'Result text',
      }],
    };
  },
);
```

## Guidelines

- Use `zod/v4` for input schemas (import as `import * as z from 'zod/v4'`).
- Always add `.describe()` to each schema field for clear documentation.
- Return results in the `content` array with `type: 'text'`.
- For errors, return an error message in `content` with `isError: true`.
- Add the tool registration in the server's `src/index.ts` (or a dedicated tools file if the server has one).
- If needed, create helper functions for API calls or data processing above the tool registration.
