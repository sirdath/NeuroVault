import { describe, expect, it } from "vitest";
import { formatQuickCapture } from "./QuickCapture";

describe("formatQuickCapture", () => {
  it("uses the first line as the title without duplicating it in the note", () => {
    expect(formatQuickCapture("A useful thought")).toEqual({
      title: "A useful thought",
      markdown: "# A useful thought\n",
    });
  });

  it("keeps the remaining lines as the note body", () => {
    expect(formatQuickCapture("## Project decision\n\nShip the simpler flow.")).toEqual({
      title: "Project decision",
      markdown: "# Project decision\n\nShip the simpler flow.",
    });
  });

  it("preserves title overflow instead of discarding captured text", () => {
    const firstLine = "a".repeat(84);
    const result = formatQuickCapture(firstLine);
    expect(result.title).toBe("a".repeat(80));
    expect(result.markdown).toBe(`# ${"a".repeat(80)}\n\naaaa`);
  });
});
