import { describe, expect, it } from "vitest";
import { stableRecallFilenames } from "./noteStore";

describe("stableRecallFilenames", () => {
  it("uses stable filenames when two notes have the same title", () => {
    const notes = [
      { filename: "projects/plan.md", title: "Plan" },
      { filename: "archive/plan.md", title: "Plan" },
    ];
    const hits = [
      { filename: "archive/plan.md", title: "Plan" },
      { filename: "archive/plan.md", title: "Plan" },
    ];

    expect(stableRecallFilenames(hits, notes)).toEqual(["archive/plan.md"]);
  });

  it("drops stale hits that are not present in the selected library", () => {
    expect(
      stableRecallFilenames(
        [{ filename: "other-vault/private.md" }],
        [{ filename: "local.md" }],
      ),
    ).toEqual([]);
  });
});
