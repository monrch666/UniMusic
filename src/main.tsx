import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./visualizer.css";
import "./settings.css";

createRoot(document.getElementById("root")!).render(<App />);
