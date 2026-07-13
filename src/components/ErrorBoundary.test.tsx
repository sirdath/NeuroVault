import axe from "axe-core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

function Crash(): never {
  throw new Error("Malformed note");
}

describe("ErrorBoundary", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("shows an honest, focused recovery surface with selectable details", async () => {
    const { container } = render(
      <ErrorBoundary>
        <Crash />
      </ErrorBoundary>,
    );
    const heading = screen.getByRole("heading", { name: "Something crashed while rendering" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByText(/did not attempt to delete or rewrite/i)).toBeVisible();
    expect(screen.getByLabelText("Error details")).toHaveAttribute("data-selectable", "true");
    expect(
      (await axe.run(container, { rules: { "color-contrast": { enabled: false } } })).violations,
    ).toEqual([]);
  });

  it("reports successful diagnostic copying", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    render(
      <ErrorBoundary>
        <Crash />
      </ErrorBoundary>,
    );
    await user.click(screen.getByRole("button", { name: "Copy diagnostic details" }));
    expect(writeText).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveTextContent("Diagnostic details copied.");
  });
});
