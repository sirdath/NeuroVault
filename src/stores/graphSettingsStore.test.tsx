import { beforeEach, describe, expect, it, vi } from "vitest";

import { ATLAS_PATTERN_IDS } from "../lib/atlasPatterns";

/**
 * The preset migration is one-shot and destructive: it reads the two legacy
 * keys and immediately deletes them, so a bug here silently resets a user's
 * view and there is no second chance to get it right. `load()` runs at module
 * import time, so every case re-imports the module with a fresh localStorage.
 */

const SETTINGS_KEY = "nv.graph.settings";
const LEGACY_MODE_KEY = "nv.graph.mode";
const LEGACY_PATTERN_KEY = "nv.atlas.pattern";

async function freshStore() {
  vi.resetModules();
  return await import("./graphSettingsStore");
}

beforeEach(() => {
  localStorage.clear();
});

describe("preset migration off the legacy keys", () => {
  it("keeps a user who chose 3D in 3D", async () => {
    localStorage.setItem(LEGACY_MODE_KEY, "3d");
    const { useGraphSettingsStore } = await freshStore();
    expect(useGraphSettingsStore.getState().preset).toBe("3d");
  });

  it("lands a user who chose 2D in 2D", async () => {
    localStorage.setItem(LEGACY_MODE_KEY, "2d");
    const { useGraphSettingsStore } = await freshStore();
    expect(useGraphSettingsStore.getState().preset).toBe("2d");
  });

  it("defaults to 2D for a brand-new user with no keys at all", async () => {
    const { useGraphSettingsStore } = await freshStore();
    expect(useGraphSettingsStore.getState().preset).toBe("2d");
  });

  it("deletes both legacy keys so the migration cannot run twice", async () => {
    localStorage.setItem(LEGACY_MODE_KEY, "3d");
    localStorage.setItem(LEGACY_PATTERN_KEY, "halo");
    await freshStore();
    expect(localStorage.getItem(LEGACY_MODE_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_PATTERN_KEY)).toBeNull();
  });

  it("does NOT resurrect the Engine from a stale pattern key", async () => {
    // The old code never persisted "engine", so a lingering pattern key is not
    // evidence the user wanted a composition -- they had already been dropped
    // back into a snapshot. Honouring it would strand them somewhere they
    // never chose.
    localStorage.setItem(LEGACY_MODE_KEY, "2d");
    localStorage.setItem(LEGACY_PATTERN_KEY, "globe");
    const { useGraphSettingsStore } = await freshStore();
    expect(useGraphSettingsStore.getState().preset).toBe("2d");
  });

  it("honours a legacy mode even when no settings blob exists yet", async () => {
    // A user who never opened Settings has no nv.graph.settings, only the
    // legacy key. That path returns DEFAULTS and must still migrate.
    expect(localStorage.getItem(SETTINGS_KEY)).toBeNull();
    localStorage.setItem(LEGACY_MODE_KEY, "3d");
    const { useGraphSettingsStore } = await freshStore();
    expect(useGraphSettingsStore.getState().preset).toBe("3d");
  });
});

describe("preset persistence", () => {
  it("prefers a stored preset over the legacy key", async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ preset: "halo" }));
    localStorage.setItem(LEGACY_MODE_KEY, "3d");
    const { useGraphSettingsStore } = await freshStore();
    expect(useGraphSettingsStore.getState().preset).toBe("halo");
  });

  it("falls back rather than trusting an unknown stored preset", async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ preset: "brain-warp" }));
    const { useGraphSettingsStore } = await freshStore();
    expect(useGraphSettingsStore.getState().preset).toBe("2d");
  });

  it("survives a corrupt settings blob", async () => {
    localStorage.setItem(SETTINGS_KEY, "{not json");
    localStorage.setItem(LEGACY_MODE_KEY, "3d");
    const { useGraphSettingsStore } = await freshStore();
    expect(useGraphSettingsStore.getState().preset).toBe("3d");
  });

  it("round-trips setPreset through localStorage", async () => {
    const { useGraphSettingsStore } = await freshStore();
    useGraphSettingsStore.getState().setPreset("dendrite");
    expect(useGraphSettingsStore.getState().preset).toBe("dendrite");

    const reloaded = await freshStore();
    expect(reloaded.useGraphSettingsStore.getState().preset).toBe("dendrite");
  });

  it("does not clobber unrelated settings when the preset changes", async () => {
    const { useGraphSettingsStore } = await freshStore();
    useGraphSettingsStore.getState().setPalette("cool");
    useGraphSettingsStore.getState().setPreset("flow");

    const reloaded = await freshStore();
    expect(reloaded.useGraphSettingsStore.getState().palette).toBe("cool");
    expect(reloaded.useGraphSettingsStore.getState().preset).toBe("flow");
  });
});

describe("presetRenderer", () => {
  it("routes the two snapshots to their own renderers", async () => {
    const { presetRenderer } = await freshStore();
    expect(presetRenderer("2d")).toBe("2d");
    expect(presetRenderer("3d")).toBe("3d");
  });

  it("routes every shipped composition to the engine", async () => {
    const { presetRenderer } = await freshStore();
    for (const id of ATLAS_PATTERN_IDS) {
      expect(presetRenderer(id)).toBe("engine");
    }
  });
});

describe("isGraphPreset", () => {
  it("accepts every id we actually ship", async () => {
    // Drift guard: adding a composition without teaching the preset validator
    // about it would make its preset unselectable and silently reset to 2D.
    const { isGraphPreset } = await freshStore();
    for (const id of ATLAS_PATTERN_IDS) {
      expect(isGraphPreset(id)).toBe(true);
    }
    expect(isGraphPreset("2d")).toBe(true);
    expect(isGraphPreset("3d")).toBe(true);
  });

  it("rejects removed patterns and junk", async () => {
    const { isGraphPreset } = await freshStore();
    for (const bad of ["engine", "identity", "spiral", "brain-warp", "", null, undefined, 3]) {
      expect(isGraphPreset(bad)).toBe(false);
    }
  });
});
