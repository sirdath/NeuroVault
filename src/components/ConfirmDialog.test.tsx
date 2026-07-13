import axe from "axe-core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";

function Fixture({ onConfirm = vi.fn() }: { onConfirm?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open dialog</button>
      <ConfirmDialog
        open={open}
        title="Delete note?"
        message="This moves the note to trash."
        onConfirm={onConfirm}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}

describe("ConfirmDialog", () => {
  it("labels the destructive dialog and keeps keyboard focus inside", async () => {
    const user = userEvent.setup();
    const { container } = render(<Fixture />);
    await user.click(screen.getByRole("button", { name: "Open dialog" }));

    const dialog = screen.getByRole("alertdialog", { name: "Delete note?" });
    expect(dialog).toHaveAccessibleDescription("This moves the note to trash.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());

    await user.tab();
    expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();

    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });

  it("cancels with Escape and restores focus to the opener", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    const opener = screen.getByRole("button", { name: "Open dialog" });
    await user.click(opener);
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("only confirms through the explicit confirm control", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<Fixture onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "Open dialog" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
