import axe from "axe-core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { useSettingsStore } from "../stores/settingsStore";
import { type Toast, useToastStore } from "../stores/toastStore";
import { Toasts } from "./Toasts";

const notification = (type: Toast["type"], message: string): Toast => ({
  id: `${type}-1`,
  type,
  message,
  createdAt: 1,
});

describe("Toasts", () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
    useSettingsStore.setState({ reduceMotion: false });
  });

  it("announces errors assertively and does not rely on colour alone", async () => {
    useToastStore.setState({ toasts: [notification("error", "Could not save")] });
    const { container } = render(<Toasts />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(alert).toHaveTextContent("error: Could not save");
    expect(
      await axe.run(container, { rules: { "color-contrast": { enabled: false } } }),
    ).toMatchObject({ violations: [] });
  });

  it("exposes disposable notices politely and supports an accessible dismissal", async () => {
    useToastStore.setState({ toasts: [notification("success", "Saved locally")] });
    const user = userEvent.setup();
    render(<Toasts />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    await user.click(screen.getByRole("button", { name: "Dismiss success notification" }));
    await waitFor(() => expect(screen.queryByText("Saved locally")).not.toBeInTheDocument());
  });

  it("renders without entrance motion when the app setting is enabled", () => {
    useSettingsStore.setState({ reduceMotion: true });
    useToastStore.setState({ toasts: [notification("info", "Memory indexed")] });
    render(<Toasts />);
    expect(screen.getByRole("status")).toBeVisible();
  });
});
