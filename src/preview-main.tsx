/**
 * Dev-only preview harness: renders the Memory Review surface without
 * the Tauri app shell (which requires the Tauri runtime and crashes in
 * a plain browser). Serve with `npm run dev`, open /preview.html.
 * Used for visual verification against the live API on :8765.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import MemoryInspector from "./components/MemoryInspector";

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <React.StrictMode>
      <MemoryInspector onClose={() => undefined} />
    </React.StrictMode>
  );
}
