import React from "react";
import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import App from "./App";
import { BrowserWindowApp } from "./BrowserWindowApp";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element was not found.");
}

/**
 * One bundle, two windows. The detached browser window loads the same file with
 * `?view=browser` and renders only the browser — cheaper than a second entry
 * point, and it keeps the two views from drifting apart.
 */
const isBrowserWindow = new URLSearchParams(window.location.search).get("view") === "browser";

ReactDOM.createRoot(root).render(
  <React.StrictMode>{isBrowserWindow ? <BrowserWindowApp /> : <App />}</React.StrictMode>,
);
