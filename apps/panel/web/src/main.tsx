import { createRoot } from "react-dom/client";

import App from "./app";

import "./styles.css";

const container = document.querySelector("#root");
if (container === null) {
  throw new Error("panel: #root element missing");
}
createRoot(container).render(<App />);
