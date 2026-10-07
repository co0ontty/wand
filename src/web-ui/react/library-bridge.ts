import {
  Alert, Avatar, Badge, Button, Card, Checkbox, Collapse, DatePicker, Descriptions, Dropdown, Empty, Flex,
  Form, Input, InputNumber, List, Progress, Space, Spin, Tabs, Tag, Timeline, Tooltip, Typography,
} from "./design-library";
import { Bubble, FileCard, Sender, Think } from "./x-library";
import * as ui from "./ui";
import * as theme from "./theme";
import * as styles from "./styles";
import * as motion from "./ui/motion-tokens";
import * as portal from "./ui/portal-context";
import * as popup from "./ui/popup-lifecycle";

// Only the current independent IIFE's consumed controls are eagerly shared.
// The public library barrels keep their exports; unused controls can tree-shake
// from the cold bundle rather than being retained by a namespace import.
const antd = { Alert, Avatar, Badge, Button, Card, Checkbox, Collapse, DatePicker, Descriptions, Dropdown, Empty,
  Flex, Form, Input, InputNumber, List, Progress, Space, Spin, Tabs, Tag, Timeline, Tooltip, Typography };
const x = { Bubble, FileCard, Sender, Think };

const sharedModules: Record<string, object> = {
  antd, "@ant-design/x": x,
  "design-library": antd, "x-library": x,
  ui, theme, styles,
  "ui/motion-tokens": motion, "ui/portal-context": portal, "ui/popup-lifecycle": popup,
};

declare global {
  var __wandSharedLibrary: ((key: string) => object) | undefined;
}

/** Share exact component/provider modules with independent IIFEs, never a second runtime. */
export function installSharedLibraryBridge(): void {
  globalThis.__wandSharedLibrary = (key: string): object => {
    const module = sharedModules[key];
    if (!module) throw new Error(`Unknown Wand shared library module: ${key}`);
    return module;
  };
}
