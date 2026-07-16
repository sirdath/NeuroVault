import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { GraphPresetBar, GRAPH_PRESETS, PRESET_HINTS, PRESET_LABELS } from "./GraphPresetBar";
import { ATLAS_BUILT_IN_PATTERNS } from "../lib/atlasPatterns";
import { isGraphPreset, presetRenderer } from "../stores/graphSettingsStore";

/**
 * The preset bar is now the ONLY way to change what the graph looks like, so a
 * pill that does not fire, or a preset with no pill, is a view the user cannot
 * reach at all. The old design hid six of eight views behind an "Open Graph
 * Engine" button; the point of this component is that none are hidden.
 */

describe("coverage — every preset is reachable", () => {
  it("renders one pill per preset, and every preset is a real one", () => {
    render(<GraphPresetBar preset="2d" onSelect={() => {}} />);
    const pills = screen.getAllByRole("button");
    expect(pills).toHaveLength(GRAPH_PRESETS.length);
    for (const id of GRAPH_PRESETS) {
      expect(isGraphPreset(id)).toBe(true);
    }
  });

  it("offers both snapshots and all six shipped compositions", () => {
    // Drift guard: ship a composition without adding it here and it becomes
    // unreachable — exactly the failure the Engine button used to cause.
    expect(GRAPH_PRESETS).toContain("2d");
    expect(GRAPH_PRESETS).toContain("3d");
    for (const pattern of ATLAS_BUILT_IN_PATTERNS) {
      expect(GRAPH_PRESETS).toContain(pattern.id);
    }
    expect(GRAPH_PRESETS).toHaveLength(2 + ATLAS_BUILT_IN_PATTERNS.length);
  });

  it("labels and describes every preset — no unlabelled pill can ship", () => {
    for (const id of GRAPH_PRESETS) {
      expect(PRESET_LABELS[id]).toBeTruthy();
      expect(PRESET_HINTS[id]).toBeTruthy();
    }
  });

  it("routes exactly two presets to non-engine renderers", () => {
    const engine = GRAPH_PRESETS.filter((p) => presetRenderer(p) === "engine");
    expect(engine).toHaveLength(ATLAS_BUILT_IN_PATTERNS.length);
    expect(GRAPH_PRESETS.filter((p) => presetRenderer(p) !== "engine")).toEqual(["2d", "3d"]);
  });
});

describe("naming", () => {
  it("does not call two different presets a globe", () => {
    // The 3D snapshot and the globe composition are both spheres. Shipping
    // "3D Globe" next to "Knowledge Globe" made them impossible to tell apart,
    // which is why the true-3D view is just "3D".
    const globey = GRAPH_PRESETS.filter((id) => /globe|orb|sphere/i.test(PRESET_LABELS[id]));
    expect(globey).toEqual(["globe"]);
    expect(PRESET_LABELS["3d"]).toBe("3D");
  });

  it("keeps every label short enough to stay on one row", () => {
    for (const id of GRAPH_PRESETS) {
      expect(PRESET_LABELS[id].length).toBeLessThanOrEqual(10);
    }
  });
});

describe("behaviour", () => {
  it("fires onSelect with the clicked preset", async () => {
    const onSelect = vi.fn();
    render(<GraphPresetBar preset="2d" onSelect={onSelect} />);
    await userEvent.click(screen.getByRole("button", { name: /^Time Rings/ }));
    expect(onSelect).toHaveBeenCalledWith("timeline");
  });

  it("fires for EVERY pill — a dead pill is an unreachable view", async () => {
    for (const id of GRAPH_PRESETS) {
      const onSelect = vi.fn();
      const { unmount } = render(<GraphPresetBar preset="2d" onSelect={onSelect} />);
      await userEvent.click(
        screen.getByRole("button", { name: new RegExp(`^${PRESET_LABELS[id]} —`) }),
      );
      expect(onSelect, `pill "${PRESET_LABELS[id]}" did not fire`).toHaveBeenCalledWith(id);
      unmount();
    }
  });

  it("marks only the active preset as pressed", () => {
    render(<GraphPresetBar preset="halo" onSelect={() => {}} />);
    const pressed = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(1);
    expect(pressed[0]).toHaveAccessibleName(/^Halo —/);
  });

  it("moves the pressed state when the preset changes", () => {
    const { rerender } = render(<GraphPresetBar preset="2d" onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: /^2D —/ })).toHaveAttribute("aria-pressed", "true");
    rerender(<GraphPresetBar preset="flow" onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: /^2D —/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /^Flow —/ })).toHaveAttribute("aria-pressed", "true");
  });
});
