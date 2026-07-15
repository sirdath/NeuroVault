import { describe, expect, it } from "vitest";
import {
  claudeCodeMcpCommand,
  claudeCodeMcpJson,
  continueMcpYaml,
  standardMcpJson,
  vscodeMcpJson,
} from "./mcpConfig";

describe("MCP client config generators", () => {
  const path = "/Applications/Neuro Vault's.app/Contents/neurovault-server";

  it("preserves paths with spaces and quotes in JSON formats", () => {
    expect(JSON.parse(standardMcpJson(path))).toEqual({
      mcpServers: { neurovault: { command: path, args: ["--mcp-only"] } },
    });
    expect(JSON.parse(claudeCodeMcpJson(path)).mcpServers.neurovault).toMatchObject({
      type: "stdio",
      command: path,
      args: ["--mcp-only"],
    });
    expect(JSON.parse(vscodeMcpJson(path))).toEqual({
      servers: {
        neurovault: { type: "stdio", command: path, args: ["--mcp-only"] },
      },
    });
  });

  it("quotes terminal and YAML values without losing the literal path", () => {
    expect(claudeCodeMcpCommand(path)).toContain("'/Applications/Neuro Vault'\\''s.app/Contents/neurovault-server'");
    expect(continueMcpYaml(path)).toContain(`command: ${JSON.stringify(path)}`);
    expect(continueMcpYaml(path)).toContain("      - --mcp-only");
  });
});
