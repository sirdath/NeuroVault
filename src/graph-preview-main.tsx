import { createRoot } from "react-dom/client";
import "./index.css";
import { NeuralGraph } from "./components/NeuralGraph";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <main style={{ display: "flex", width: "100vw", height: "100vh" }}>
      <NeuralGraph />
    </main>,
  );
}
