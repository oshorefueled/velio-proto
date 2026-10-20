import { createElement, type ReactNode } from "react";

/**
 * Inline glyphs for the revamped surfaces: chips, sidebar rows, buttons.
 * Stroke icons inherit currentColor so context sets the tone.
 */

function svg(children: ReactNode, size = 14): ReactNode {
  return createElement(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": true,
      focusable: false,
    },
    children,
  );
}

export const CalendarIcon = (): ReactNode =>
  svg([
    createElement("rect", { key: "r", x: 3, y: 5, width: 18, height: 16, rx: 2 }),
    createElement("path", { key: "p", d: "M16 3v4M8 3v4M3 11h18" }),
  ]);

export const ClockIcon = (): ReactNode =>
  svg([createElement("circle", { key: "c", cx: 12, cy: 12, r: 9 }), createElement("path", { key: "p", d: "M12 7v5l3 2" })]);

export const PersonIcon = ({ size = 14 }: { size?: number }): ReactNode =>
  svg([createElement("circle", { key: "c", cx: 12, cy: 8, r: 4 }), createElement("path", { key: "p", d: "M4 21c1.5-4 5-5.5 8-5.5s6.5 1.5 8 5.5" })], size);

export const GroupIcon = (): ReactNode =>
  svg([
    createElement("circle", { key: "c", cx: 9, cy: 8, r: 3.5 }),
    createElement("path", { key: "p1", d: "M2.5 20c1.2-3.4 4-4.8 6.5-4.8s5.3 1.4 6.5 4.8" }),
    createElement("path", { key: "p2", d: "M16 5a3.5 3.5 0 0 1 0 6.5M18.5 15.6c1.6.7 2.6 2.1 3 4.4" }),
  ]);

export const ArrowRightIcon = ({ size = 16 }: { size?: number }): ReactNode =>
  svg([createElement("path", { key: "p", d: "M4 12h15M13 6l6 6-6 6" })], size);

export const ArrowLeftIcon = (): ReactNode =>
  svg([createElement("path", { key: "p", d: "M20 12H5M11 6l-6 6 6 6" })]);

export const GlobeIcon = (): ReactNode =>
  svg([
    createElement("circle", { key: "c", cx: 12, cy: 12, r: 9 }),
    createElement("path", { key: "p", d: "M3 12h18M12 3c2.7 2.6 4 5.6 4 9s-1.3 6.4-4 9c-2.7-2.6-4-5.6-4-9s1.3-6.4 4-9z" }),
  ]);

export const InfoIcon = (): ReactNode =>
  svg([createElement("circle", { key: "c", cx: 12, cy: 12, r: 9 }), createElement("path", { key: "p", d: "M12 11v5M12 8h.01" })]);
