import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { Minitab } from "./components/Minitab";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { SplashScreen } from "./components/SplashScreen";
import "./index.css";

// The minitab is a second, frameless Tauri window that loads this same
// bundle with `?view=minitab`. Render the compact control there instead of
// the full app. (Synchronous query check — no flash of the big app first.)
const params = new URLSearchParams(window.location.search);
const isMinitab = params.get("view") === "minitab";
if (isMinitab) document.documentElement.classList.add("minitab-window");

// The Employee Manager is a second window too (`?window=employees`):
// the employee interface with no notes chrome. Today it hosts the
// Curator; at employee #2 it grows a roster and becomes the manager.
const isEmployeeWindow = params.get("window") === "employees";

// Lazy so the main window's bundle path stays untouched.
const EmployeeWindow = React.lazy(() =>
  import("./components/EmployeeManager").then((m) => ({
    default: m.EmployeeManager,
  }))
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      {isMinitab ? (
        <Minitab />
      ) : isEmployeeWindow ? (
        <div
          style={{
            height: "100vh",
            overflow: "auto",
            background: "var(--nv-bg)",
            color: "var(--nv-text)",
          }}
        >
          <React.Suspense fallback={null}>
            <EmployeeWindow />
          </React.Suspense>
        </div>
      ) : (
        <>
          <App />
          <SplashScreen />
        </>
      )}
    </ErrorBoundary>
  </React.StrictMode>
);
