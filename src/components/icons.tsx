// SF-Symbols-style line icons. Thin (1.25px), centered in 16x16 by default.
import type { CSSProperties, ReactNode } from "react";

type IconProps = {
  d?: string | ReactNode;
  size?: number;
  stroke?: number;
  fill?: string;
  style?: CSSProperties;
  className?: string;
};

export const Icon = ({
  d,
  size = 14,
  stroke = 1.25,
  fill = "none",
  style,
  className,
}: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill={fill}
    stroke="currentColor"
    strokeWidth={stroke}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={style}
    className={className}
  >
    {typeof d === "string" ? <path d={d} /> : d}
  </svg>
);

// Path strings (canonical) — use I.<name> for raw paths or Glyph.<name> for prebuilt icons.
export const P = {
  chevronRight: "M6 3l4 5-4 5",
  chevronDown:  "M3 6l5 4 5-4",
  chevronLeft:  "M10 3L6 8l4 5",
  cursor: "M3 2l9 5-4 1.5L7 13z",
  cloud: "M4 11h7.5a2.5 2.5 0 000-5 3.5 3.5 0 00-6.7-1A2.6 2.6 0 004 11z",
  area: "M3 5V3h2M11 3h2v2M13 11v2h-2M5 13H3v-2",
  pause: "M5.5 3v10M10.5 3v10",
  play:  "M5 3v10l8-5z",
  trash: undefined as never, // see Glyph
  resize: "M11 5h2v2M5 11H3v-2M5 11l8-8M3 13l8-8",
  edit: "M3 13l2-.5L13 4.5 11.5 3 3.5 11z",
  plus: "M8 3v10M3 8h10",
  check: "M3 8.5l3 3 7-7",
  folder: "M2 4.5A1.5 1.5 0 013.5 3h2L7 4.5h5.5A1.5 1.5 0 0114 6v5.5A1.5 1.5 0 0112.5 13h-9A1.5 1.5 0 012 11.5z",
  command: "M5 5h6v6H5zM5 5V3.5A1.5 1.5 0 003.5 5zM11 5V3.5A1.5 1.5 0 0112.5 5zM5 11v1.5A1.5 1.5 0 013.5 11zM11 11v1.5A1.5 1.5 0 0012.5 11z",
  shield: "M8 1.5L13 3v4.5c0 3.5-2.5 6-5 7-2.5-1-5-3.5-5-7V3z",
  power: "M8 2v6M4 4.5a5 5 0 108 0",
  moon: "M13 9.5A5.5 5.5 0 016.5 3a5.5 5.5 0 106.5 6.5z",
  filter: "M2.5 4h11l-4 5v4l-3-1.5V9z",
  external: "M9 3h4v4M13 3l-6 6M7 4H4a1 1 0 00-1 1v7a1 1 0 001 1h7a1 1 0 001-1V9",
  rectGlyph: "M2 4.5A1.5 1.5 0 013.5 3h2L7 4.5h5.5A1.5 1.5 0 0114 6v5.5A1.5 1.5 0 0112.5 13h-9A1.5 1.5 0 012 11.5z",
} as const;

// Prebuilt icon nodes — call these directly in JSX.
export const I = {
  chevronRight: <Icon d={P.chevronRight} />,
  chevronDown:  <Icon d={P.chevronDown} />,
  chevronLeft:  <Icon d={P.chevronLeft} />,
  gear: (
    <Icon d={
      <>
        <circle cx="8" cy="8" r="2"/>
        <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3"/>
      </>
    }/>
  ),
  video: <Icon d={<><rect x="1.5" y="4" width="9" height="8" rx="1.5"/><path d="M10.5 7l4-2v6l-4-2z"/></>}/>,
  webcam: <Icon d={<><circle cx="8" cy="8" r="4"/><circle cx="8" cy="8" r="1.5"/></>}/>,
  square: <Icon d={<rect x="3" y="3" width="10" height="10" rx="1"/>}/>,
  rect:   <Icon d={<rect x="2" y="4" width="12" height="8" rx="1"/>}/>,
  window: <Icon d={<><rect x="2" y="3" width="12" height="10" rx="1"/><path d="M2 6h12"/></>}/>,
  area:   <Icon d={P.area}/>,
  monitor: <Icon d={<><rect x="1.5" y="3" width="13" height="9" rx="1"/><path d="M5 14h6"/></>}/>,
  mic: <Icon d={<><rect x="6" y="2" width="4" height="7" rx="2"/><path d="M3.5 8a4.5 4.5 0 009 0M8 12.5V14"/></>}/>,
  micOff: <Icon d={<><path d="M3.5 8a4.5 4.5 0 008 2.5M6 4.5V4a2 2 0 014 0v3M2 2l12 12"/></>}/>,
  pause: <Icon d={P.pause}/>,
  play:  <Icon d={P.play}/>,
  stop:  <Icon d={<rect x="4" y="4" width="8" height="8" rx="0.5" fill="currentColor"/>}/>,
  trash: <Icon d={<><path d="M3 4h10M5 4V2.5h6V4M5 4l.5 9h5L11 4"/></>}/>,
  more:  <Icon d="M3 8h.01M8 8h.01M13 8h.01" stroke={2.2}/>,
  share: <Icon d={<><path d="M8 2v8M5 5l3-3 3 3"/><path d="M3 9v3.5A1.5 1.5 0 004.5 14h7a1.5 1.5 0 001.5-1.5V9"/></>}/>,
  link: <Icon d={<><path d="M7 9l2-2"/><path d="M6 5.5L7.5 4a2.5 2.5 0 013.5 3.5L9.5 9"/><path d="M10 10.5L8.5 12a2.5 2.5 0 01-3.5-3.5L6.5 7"/></>}/>,
  finder: <Icon d={<><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M5 6c0 1 .5 2 1 2.5M11 6c0 1-.5 2-1 2.5M5 11c1 .8 5 .8 6 0"/></>}/>,
  edit: <Icon d={P.edit}/>,
  download: <Icon d={<><path d="M8 2v8M4.5 7L8 10.5 11.5 7"/><path d="M3 13h10"/></>}/>,
  plus: <Icon d={P.plus}/>,
  search: <Icon d={<><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></>}/>,
  check: <Icon d={P.check}/>,
  resize: <Icon d={P.resize}/>,
  bell: <Icon d="M4 11V7a4 4 0 018 0v4l1 2H3zM6.5 13a1.5 1.5 0 003 0"/>,
  folder: <Icon d={P.folder}/>,
  command: <Icon d={P.command}/>,
  history: <Icon d={<><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5M3 5l-1-2"/></>}/>,
};
