import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { Minitab } from "./components/Minitab";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";

// The minitab is a second, frameless Tauri window that loads this same
// bundle with `?view=minitab`. Render the compact control there instead of
// the full app. (Synchronous query check — no flash of the big app first.)
const isMinitab =
  new URLSearchParams(window.location.search).get("view") === "minitab";
if (isMinitab) document.documentElement.classList.add("minitab-window");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>{isMinitab ? <Minitab /> : <App />}</ErrorBoundary>
  </React.StrictMode>
);
