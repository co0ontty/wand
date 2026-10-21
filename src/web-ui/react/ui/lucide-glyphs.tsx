// Lucide SVG geometry. ISC / Feather MIT; see content/licenses/lucide.txt (shipped in dist/web-ui).
// Only the approved workbar family opts in; existing application icons stay unchanged.
import * as React from "react";

const nodes: Record<string, Array<[string, Record<string, string>]>> = {
  "folder": [
    [
      "path",
      {
        "d": "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"
      }
    ],
    [
      "path",
      {
        "d": "M2 10h20"
      }
    ]
  ],
  "terminal": [
    [
      "path",
      {
        "d": "M12 19h8"
      }
    ],
    [
      "path",
      {
        "d": "m4 17 6-6-6-6"
      }
    ]
  ],
  "explorer": [
    [
      "path",
      {
        "d": "M15 2h-4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8"
      }
    ],
    [
      "path",
      {
        "d": "M16.706 2.706A2.4 2.4 0 0 0 15 2v5a1 1 0 0 0 1 1h5a2.4 2.4 0 0 0-.706-1.706z"
      }
    ],
    [
      "path",
      {
        "d": "M5 7a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 1.732-1"
      }
    ]
  ],
  "more": [
    [
      "circle",
      {
        "cx": "12",
        "cy": "12",
        "r": "1"
      }
    ],
    [
      "circle",
      {
        "cx": "12",
        "cy": "5",
        "r": "1"
      }
    ],
    [
      "circle",
      {
        "cx": "12",
        "cy": "19",
        "r": "1"
      }
    ]
  ],
  "plus": [
    [
      "path",
      {
        "d": "M5 12h14"
      }
    ],
    [
      "path",
      {
        "d": "M12 5v14"
      }
    ]
  ],
  "close": [
    [
      "path",
      {
        "d": "M18 6 6 18"
      }
    ],
    [
      "path",
      {
        "d": "m6 6 12 12"
      }
    ]
  ],
  "git": [
    [
      "path",
      {
        "d": "M15 6a9 9 0 0 0-9 9V3"
      }
    ],
    [
      "circle",
      {
        "cx": "18",
        "cy": "6",
        "r": "3"
      }
    ],
    [
      "circle",
      {
        "cx": "6",
        "cy": "18",
        "r": "3"
      }
    ]
  ],
  "branch": [
    [
      "path",
      {
        "d": "M15 6a9 9 0 0 0-9 9V3"
      }
    ],
    [
      "circle",
      {
        "cx": "18",
        "cy": "6",
        "r": "3"
      }
    ],
    [
      "circle",
      {
        "cx": "6",
        "cy": "18",
        "r": "3"
      }
    ]
  ],
  "rail": [
    [
      "rect",
      {
        "width": "18",
        "height": "18",
        "x": "3",
        "y": "3",
        "rx": "2"
      }
    ],
    [
      "path",
      {
        "d": "M9 3v18"
      }
    ]
  ],
  "splitHorizontal": [
    [
      "rect",
      {
        "width": "18",
        "height": "18",
        "x": "3",
        "y": "3",
        "rx": "2"
      }
    ],
    [
      "path",
      {
        "d": "M12 3v18"
      }
    ]
  ],
  "splitVertical": [
    [
      "rect",
      {
        "width": "18",
        "height": "18",
        "x": "3",
        "y": "3",
        "rx": "2"
      }
    ],
    [
      "path",
      {
        "d": "M3 12h18"
      }
    ]
  ],
  "copy": [
    [
      "rect",
      {
        "width": "14",
        "height": "14",
        "x": "8",
        "y": "8",
        "rx": "2",
        "ry": "2"
      }
    ],
    [
      "path",
      {
        "d": "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"
      }
    ]
  ],
  "trash": [
    [
      "path",
      {
        "d": "M10 11v6"
      }
    ],
    [
      "path",
      {
        "d": "M14 11v6"
      }
    ],
    [
      "path",
      {
        "d": "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"
      }
    ],
    [
      "path",
      {
        "d": "M3 6h18"
      }
    ],
    [
      "path",
      {
        "d": "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
      }
    ]
  ],
  "hash": [
    [
      "line",
      {
        "x1": "4",
        "x2": "20",
        "y1": "9",
        "y2": "9"
      }
    ],
    [
      "line",
      {
        "x1": "4",
        "x2": "20",
        "y1": "15",
        "y2": "15"
      }
    ],
    [
      "line",
      {
        "x1": "10",
        "x2": "8",
        "y1": "3",
        "y2": "21"
      }
    ],
    [
      "line",
      {
        "x1": "16",
        "x2": "14",
        "y1": "3",
        "y2": "21"
      }
    ]
  ],
  "merge": [
    [
      "circle",
      {
        "cx": "18",
        "cy": "18",
        "r": "3"
      }
    ],
    [
      "circle",
      {
        "cx": "6",
        "cy": "6",
        "r": "3"
      }
    ],
    [
      "path",
      {
        "d": "M6 21V9a9 9 0 0 0 9 9"
      }
    ]
  ],
  "check": [
    [
      "path",
      {
        "d": "M20 6 9 17l-5-5"
      }
    ]
  ],
  "chevronLeft": [
    [
      "path",
      {
        "d": "m12 19-7-7 7-7"
      }
    ],
    [
      "path",
      {
        "d": "M19 12H5"
      }
    ]
  ],
  "eye": [
    [
      "path",
      {
        "d": "M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"
      }
    ],
    [
      "circle",
      {
        "cx": "12",
        "cy": "12",
        "r": "3"
      }
    ]
  ],
  "chevronDown": [
    [
      "path",
      {
        "d": "m6 9 6 6 6-6"
      }
    ]
  ]
};

export function lucideGlyph(name: string): React.ReactNode {
  return nodes[name === "back" ? "chevronLeft" : name]?.map(([tag, attributes], key) => React.createElement(tag, { ...attributes, key }));
}
