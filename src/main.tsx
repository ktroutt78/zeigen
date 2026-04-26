import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/global.css";
import App from "./App";
import WebcamBubble from "./components/WebcamBubble";
import Review from "./Review";
import CountdownOverlay from "./CountdownOverlay";
import TimerChipWindow from "./TimerChipWindow";
import IdentifyOverlay from "./IdentifyOverlay";

const hash = window.location.hash;
const root = hash.startsWith("#bubble")
  ? <WebcamBubble />
  : hash.startsWith("#review")
  ? <Review />
  : hash.startsWith("#countdown")
  ? <CountdownOverlay />
  : hash.startsWith("#timer-chip")
  ? <TimerChipWindow />
  : hash.startsWith("#identify")
  ? <IdentifyOverlay />
  : <App />;

// Routes that render in transparent windows must not paint the global dark
// body background — otherwise the dark fill leaks through the transparent
// NSWindow and the user sees a solid backdrop instead of their screen.
const TRANSPARENT_ROUTES = ["#bubble", "#countdown", "#timer-chip", "#identify"];
if (TRANSPARENT_ROUTES.some((r) => hash.startsWith(r))) {
  document.documentElement.style.background = "transparent";
  document.body.style.background = "transparent";
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{root}</React.StrictMode>,
);
