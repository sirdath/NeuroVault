import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ShortcutHelp } from "./ShortcutHelp";

describe("ShortcutHelp", () => {
  it("documents the established number-row destinations", () => {
    render(<ShortcutHelp open onClose={vi.fn()} />);

    expect(screen.getByText("Open Today").nextElementSibling).toHaveTextContent("⌘1");
    expect(screen.getByText("Open Memories").nextElementSibling).toHaveTextContent("⌘2");
    expect(screen.getByText("Open Graph").nextElementSibling).toHaveTextContent("⌘3");
  });
});
