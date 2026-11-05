import {
  Alert, Avatar, Badge, Button, Card, Checkbox, Collapse, Descriptions, Empty, Flex,
  Input, InputNumber, List, Space, Spin, Tabs, Tag, Timeline, Tooltip, Typography,
} from "antd";
import { FileCard, Sender } from "@ant-design/x";
import * as ui from "./ui";
import * as theme from "./theme";
import * as styles from "./styles";
import * as motion from "./ui/motion-tokens";
import * as portal from "./ui/portal-context";
import * as popup from "./ui/popup-lifecycle";

// Ant Design is the common control system; X supplies only its chat extensions.
// Share exactly what the team IIFE consumes. Re-export barrels and unused
// controls would retain extra implementations in this lazy shared module.
const antd = { Alert, Avatar, Badge, Button, Card, Checkbox, Collapse, Descriptions, Empty,
  Flex, Input, InputNumber, List, Space, Spin, Tabs, Tag, Timeline, Tooltip, Typography };
const x = { FileCard, Sender };

const sharedModules: Record<string, object> = {
  antd, "@ant-design/x": x,
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
