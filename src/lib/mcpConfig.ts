export interface StdioMcpServer {
  command: string;
  args: string[];
}

export function neuroVaultStdioServer(sidecarPath: string): StdioMcpServer {
  return {
    command: sidecarPath,
    args: ["--mcp-only"],
  };
}

export function standardMcpJson(sidecarPath: string): string {
  return JSON.stringify(
    { mcpServers: { neurovault: neuroVaultStdioServer(sidecarPath) } },
    null,
    2,
  );
}

export function claudeCodeMcpJson(sidecarPath: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        neurovault: {
          type: "stdio",
          ...neuroVaultStdioServer(sidecarPath),
        },
      },
    },
    null,
    2,
  );
}

export function vscodeMcpJson(sidecarPath: string): string {
  return JSON.stringify(
    {
      servers: {
        neurovault: {
          type: "stdio",
          ...neuroVaultStdioServer(sidecarPath),
        },
      },
    },
    null,
    2,
  );
}

export function continueMcpYaml(sidecarPath: string): string {
  return [
    "mcpServers:",
    "  - name: NeuroVault",
    `    command: ${JSON.stringify(sidecarPath)}`,
    "    args:",
    "      - --mcp-only",
  ].join("\n");
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function claudeCodeMcpCommand(sidecarPath: string): string {
  return `claude mcp add --scope user neurovault ${shellQuote(sidecarPath)} -- --mcp-only`;
}
