import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/global.css";
import App from "./App";
import WebcamBubble from "./components/WebcamBubble";
import Review from "./Review";

const hash = window.location.hash;
const root = hash.startsWith("#bubble")
  ? <WebcamBubble />
  : hash.startsWith("#review")
  ? <Review />
  : <App />;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{root}</React.StrictMode>,
);
