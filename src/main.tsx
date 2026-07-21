import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { SplashScreen } from "./components/SplashScreen";
import "./index.css";

// The minitab is a second, frameless Tauri window that loads this same
// bundle with `?view=minitab`. Render the compact control there instead of
// the full app. (Synchronous query check — no flash of the big app first.)
const params = new URLSearchParams(window.location.search);
const isMinitab = import.meta.env.VITE_DISTRIBUTION !== "app-store" && params.get("view") === "minitab";
if (isMinitab) document.documentElement.classList.add("minitab-window");

const DirectMinitab = import.meta.env.VITE_DISTRIBUTION === "app-store" ? null : React.lazy(() =>
  import("./components/Minitab").then((module) => ({ default: module.Minitab })),
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      {isMinitab && DirectMinitab ? (
        <React.Suspense fallback={null}><DirectMinitab /></React.Suspense>
      ) : (
        <>
          <App />
          <SplashScreen />
        </>
      )}
    </ErrorBoundary>
  </React.StrictMode>
);
