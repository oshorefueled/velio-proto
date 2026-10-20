import "@fontsource-variable/public-sans/index.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { SessionProvider } from "./session.js";

const container = document.getElementById("root");
if (container === null) throw new Error("missing #root");
createRoot(container).render(
  <StrictMode>
    <SessionProvider>
      <App />
    </SessionProvider>
  </StrictMode>,
);
