import { describe, expect, it } from "vitest";
import { sidebarWidthFromPointer } from "./Sidebar";

describe("note-sidebar resizing", () => {
  it("measures from the note sidebar rather than from the viewport", () => {
    expect(sidebarWidthFromPointer(456, 208)).toBe(248);
    expect(sidebarWidthFromPointer(312, 64)).toBe(248);
  });

  it("keeps the existing minimum and maximum widths", () => {
    expect(sidebarWidthFromPointer(276, 208)).toBe(220);
    expect(sidebarWidthFromPointer(876, 208)).toBe(420);
  });
});
