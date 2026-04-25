import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/global.css";
import App from "./App";
import WebcamBubble from "./components/WebcamBubble";

const isBubble = window.location.hash.startsWith("#bubble");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{isBubble ? <WebcamBubble /> : <App />}</React.StrictMode>,
);
