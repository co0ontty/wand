import * as React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Alert, Empty, Input, Popover, Tree, type TreeDataNode } from "antd";
import { WandUiProvider } from "../../../src/web-ui/react/theme";
import { installReactUiStyles } from "../../../src/web-ui/react/styles";
import { WandButton, WandIconButton } from "../../../src/web-ui/react/ui/button";
import { WandIcon, type WandIconName } from "../../../src/web-ui/react/ui/icons";
import { WandBrandMark } from "../../../src/web-ui/react/ui/brand-mark";
import { WandSearchField } from "../../../src/web-ui/react/ui/search-field";
import { WandSelect } from "../../../src/web-ui/react/ui/select";
import { WandStretchTabs } from "../../../src/web-ui/react/ui/stretch-tabs";
import { MarkdownPreview } from "../../../src/web-ui/react/file-preview/markdown";
import { usePopupDismiss } from "../../../src/web-ui/react/ui/popup-lifecycle";
import { ContentInfo, originLabels, type ContentOrigin } from "./content-info";
import { DiffReview, type ReviewChange } from "./diff-review";
import { HistoryView } from "./history-view";
import { CommentsSection } from "./comments-section";
import { EditSuggestionDialog } from "./edit-suggestion-dialog";
import type { MentionTarget } from "./mention-strip";
import type { DocumentComment, DocumentRevision, DocumentWithHistory } from "./history-model";
import "./style.css";
import "./diff.css";
import "./history.css";
import "./comments.css";

type Document = DocumentWithHistory;

const libraries = [
  { id: "global", name: "全局知识", group: "全局", icon: "server" as WandIconName },
  { id: "wand", name: "Wand", group: "项目", icon: "folder" as WandIconName },
  { id: "design", name: "设计实验室", group: "项目", icon: "folder" as WandIconName },
  { id: "tiger", name: "赛博虎妞", group: "员工", icon: "user" as WandIconName },
  { id: "designer", name: "设计伙伴", group: "员工", icon: "user" as WandIconName },
];

const initialDocuments: Document[] = [
  {
    id: "global-collaboration",
    library: "global",
    origin: "manual",
    title: "沟通与协作",
    content: "## 沟通方式\n\n默认用中文沟通。先说明结论，再补充必要的背景与依据。\n\n需要做取舍时，说明选择会带来的影响；缺少必要信息时再提问。\n\n## 保留已有工作\n\n修改前先看清现有状态，保留用户已有的输入、工作与历史。\n\n## 如实交付\n\n完成后说明做了什么、验证了什么，以及还未验证的部分。只有实际保存或执行成功后，才确认结果。",
    history: [
      {
        id: "rev-gc-2",
        timestamp: "今天 11:20",
        author: "用户",
        summary: "完善如实交付与保留已有工作约定",
        source: "manual",
        title: "沟通与协作",
        content: "## 沟通方式\n\n默认用中文沟通。先说明结论，再补充必要的背景与依据。\n\n需要做取舍时，说明选择会带来的影响；缺少必要信息时再提问。\n\n## 保留已有工作\n\n修改前先看清现有状态，保留用户已有的输入、工作与历史。\n\n## 如实交付\n\n完成后说明做了什么、验证了什么，以及还未验证的部分。只有实际保存或执行成功后，才确认结果。",
      },
      {
        id: "rev-gc-1",
        timestamp: "昨天 09:00",
        author: "用户",
        summary: "初始创建全局沟通约定",
        source: "manual",
        title: "沟通与协作",
        content: "## 沟通方式\n\n默认用中文沟通。先结论后证据。\n\n缺少必要信息时先提问，不自行假设关键取舍。",
      },
    ],
    comments: [],
  },
  {
    id: "global-tools",
    library: "global",
    origin: "conversation",
    title: "工具使用偏好",
    content: "## 遵循用户的工具选择\n\n工具优先按用户明确指定的方式使用。不可用时说明原因，保留已有工作。\n\n## 操作范围\n\n长期约定用于指导协作，不额外增加数据删除、发布或凭据操作的授权。",
    history: [
      {
        id: "rev-gt-1",
        timestamp: "2天前 16:45",
        author: "对话保存 · 赛博虎妞",
        summary: "从对话中保存浏览器与操作授权约定",
        source: "manual",
        title: "工具使用偏好",
        content: "## 遵循用户的工具选择\n\n工具优先按用户明确指定的方式使用。不可用时说明原因，保留已有工作。\n\n## 操作范围\n\n长期约定用于指导协作，不额外增加数据删除、发布或凭据操作的授权。",
      },
    ],
    comments: [],
  },
  {
    id: "wand-ui",
    library: "wand",
    origin: "manual",
    title: "界面与交互约定",
    content: "设计与实现界面时，先理解现有使用流程。让用户能直接找到内容、完成操作，把注意力留给正在做的事。\n\n## 优先复用现有组件\n\n开始前先核对项目的组件库。现有组件能满足需求时直接复用；需要调整时，优先使用组件参数、主题与少量适配。\n\n按钮、输入框、选择器和文档阅读保持一致的视觉与交互，让每个页面都像同一个产品。\n\n## 展开与收起保持自然\n\n用正常的文档流安排内容。能在当前页面展开的详情，就在原位置展开，让后面的内容自然下移。\n\n- 触发按钮在展开前后保持位置与尺寸。\n- 收起沿展开的方向返回，保留用户的阅读位置。\n- 操作结果在原来的按钮位置反馈。\n\n## 各端保持一致\n\nMac 与 Web、Android 与 iOS 保持功能与交互语义一致。允许使用平台原生控件，但信息归属、操作含义和失败后的恢复方式需要一致。",
    history: [
      {
        id: "rev-wu-3",
        timestamp: "今天 14:10",
        author: "用户",
        summary: "新增「各端保持一致」多端规范",
        source: "manual",
        title: "界面与交互约定",
        content: "设计与实现界面时，先理解现有使用流程。让用户能直接找到内容、完成操作，把注意力留给正在做的事。\n\n## 优先复用现有组件\n\n开始前先核对项目的组件库。现有组件能满足需求时直接复用；需要调整时，优先使用组件参数、主题与少量适配。\n\n按钮、输入框、选择器和文档阅读保持一致的视觉与交互，让每个页面都像同一个产品。\n\n## 展开与收起保持自然\n\n用正常的文档流安排内容。能在当前页面展开的详情，就在原位置展开，让后面的内容自然下移。\n\n- 触发按钮在展开前后保持位置与尺寸。\n- 收起沿展开的方向返回，保留用户的阅读位置。\n- 操作结果在原来的按钮位置反馈。\n\n## 各端保持一致\n\nMac 与 Web、Android 与 iOS 保持功能与交互语义一致。允许使用平台原生控件，但信息归属、操作含义和失败后的恢复方式需要一致。",
      },
      {
        id: "rev-wu-2",
        timestamp: "昨天 16:30",
        author: "用户",
        summary: "细化「展开与收起保持自然」交互规则",
        source: "manual",
        title: "界面与交互约定",
        content: "设计与实现界面时，先理解现有使用流程。让用户能直接找到内容、完成操作，把注意力留给正在做的事。\n\n## 优先复用现有组件\n\n开始前先核对项目的组件库。现有组件能满足需求时直接复用；需要调整时，优先使用组件参数、主题与少量适配。\n\n## 展开与收起保持自然\n\n用正常的文档流安排内容。能在当前页面展开的详情，就在原位置展开，让后面的内容自然下移。",
      },
      {
        id: "rev-wu-1",
        timestamp: "3天前 10:00",
        author: "用户",
        summary: "初始化项目界面与交互约定",
        source: "manual",
        title: "界面与交互约定",
        content: "## 优先复用现有组件\n\n开始前先核对项目的组件库。现有组件能满足需求时直接复用；需要调整时，优先使用组件参数、主题与少量适配。",
      },
    ],
    comments: [
      {
        id: "c-wu-1",
        author: "用户",
        timestamp: "昨天 15:30",
        text: "增加展开收起保持自然和各端保持一致的说明。",
        applied: true,
        appliedInRev: "rev-wu-3",
      },
      {
        id: "c-wu-2",
        author: "赛博虎妞",
        timestamp: "今天 11:00",
        text: "后续在交付前补充关于 Git 双栏对比的组件规范与响应式断点说明。",
        applied: false,
      },
    ],
  },
  {
    id: "wand-architecture",
    library: "wand",
    origin: "conversation",
    title: "会话与执行边界",
    content: "## 职责划分\n\nServer 负责业务、存储与会话协调；终端执行的生命周期独立管理。服务更新时保留已有会话与历史。\n\n## 输入与草稿\n\n提交结果与发起提交时的会话绑定。迟到回执不能覆盖用户的新输入，结果不明确时避免重复提交。\n\n## 验证\n\n在实际运行环境中核对受影响的流程，不把局部检查通过当作所有功能都已验证。",
    history: [
      {
        id: "rev-wa-2",
        timestamp: "今天 10:00",
        author: "对话保存 · 勤劳的初二",
        summary: "补充服务更新与输入草稿绑定",
        source: "manual",
        title: "会话与执行边界",
        content: "## 职责划分\n\nServer 负责业务、存储与会话协调；终端执行的生命周期独立管理。服务更新时保留已有会话与历史。\n\n## 输入与草稿\n\n提交结果与发起提交时的会话绑定。迟到回执不能覆盖用户的新输入，结果不明确时避免重复提交。\n\n## 验证\n\n在实际运行环境中核对受影响的流程，不把局部检查通过当作所有功能都已验证。",
      },
      {
        id: "rev-wa-1",
        timestamp: "4天前 11:30",
        author: "对话保存 · 勤劳的初二",
        summary: "初始架构约定",
        source: "manual",
        title: "会话与执行边界",
        content: "## 职责划分\n\nServer 负责业务、存储与会话协调；终端执行的生命周期独立管理。",
      },
    ],
    comments: [],
  },
  {
    id: "wand-delivery",
    library: "wand",
    origin: "unknown",
    title: "构建与验收入口",
    content: "## 按影响范围验证\n\n界面修改需要核对真实阅读与交互流程。类型检查与构建通过，不等于视觉与操作体验已验收。\n\n## 交付记录\n\n写清已完成的验证、可查看的产物与尚未验证的范围，保持结论可复核。",
    history: [
      {
        id: "rev-wd-1",
        timestamp: "5天前 15:20",
        author: "历史文档",
        summary: "初始交付与验证规范",
        source: "manual",
        title: "构建与验收入口",
        content: "## 按影响范围验证\n\n界面修改需要核对真实阅读与交互流程。类型检查与构建通过，不等于视觉与操作体验已验收。\n\n## 交付记录\n\n写清已完成的验证、可查看的产物与尚未验证的范围，保持结论可复核。",
      },
    ],
    comments: [],
  },
  {
    id: "design-reading",
    library: "design",
    origin: "manual",
    title: "移动端阅读规范",
    content: "## 小屏阅读\n\n保留清楚的标题、来源和返回入口。长文在当前阅读区域滚动，主要操作始终可达。\n\n## 目录与正文\n\n点选目录进入正文，返回时保留目录展开状态和滚动位置。",
    history: [
      {
        id: "rev-dr-1",
        timestamp: "1周前",
        author: "用户",
        summary: "移动端阅读规范初稿",
        source: "manual",
        title: "移动端阅读规范",
        content: "## 小屏阅读\n\n保留清楚的标题、来源和返回入口。长文在当前阅读区域滚动，主要操作始终可达。\n\n## 目录与正文\n\n点选目录进入正文，返回时保留目录展开状态和滚动位置。",
      },
    ],
    comments: [],
  },
  {
    id: "tiger-role",
    library: "tiger",
    origin: "builtin",
    title: "角色设定",
    role: true,
    content: "你是用户的默认任务伙伴「赛博虎妞」，帮助用户完成日常任务。\n\n## 职责\n\n理解本轮目标与已有约定，协助用户完成日常协作、代码实现和问题排查。基于真实状态与验证结果交付，不编造事实。\n\n## 工作方式\n\n先看清现有实现，再采取小而准确的行动。优先复用项目已有组件与能力，保留用户正在进行的工作。\n\n需要持续处理的任务，沿着已经明确的目标继续推进。完成后说明做了什么、验证了什么，以及还未验证的部分。\n\n## 沟通习惯\n\n默认用中文简洁沟通，先结论后证据。重要取舍说明影响，缺少必要信息时再提问。\n\n## 协作边界\n\n保留已有输入、工作和历史。涉及删除、发布、权限或凭据的操作，遵守明确授权与项目约定。",
    history: [
      {
        id: "rev-tr-2",
        timestamp: "今天 12:00",
        author: "员工编辑",
        summary: "补充「先看清现有实现再动手」的工作方式",
        source: "manual",
        title: "角色设定",
        content: "你是用户的默认任务伙伴「赛博虎妞」，帮助用户完成日常任务。\n\n## 职责\n\n理解本轮目标与已有约定，协助用户完成日常协作、代码实现和问题排查。基于真实状态与验证结果交付，不编造事实。\n\n## 工作方式\n\n先看清现有实现，再采取小而准确的行动。优先复用项目已有组件与能力，保留用户正在进行的工作。\n\n需要持续处理的任务，沿着已经明确的目标继续推进。完成后说明做了什么、验证了什么，以及还未验证的部分。\n\n## 沟通习惯\n\n默认用中文简洁沟通，先结论后证据。重要取舍说明影响，缺少必要信息时再提问。\n\n## 协作边界\n\n保留已有输入、工作和历史。涉及删除、发布、权限或凭据的操作，遵守明确授权与项目约定。",
      },
      {
        id: "rev-tr-1",
        timestamp: "1周前",
        author: "系统内置模板",
        summary: "初始内置角色设定",
        source: "builtin",
        title: "角色设定",
        content: "你是用户的默认任务伙伴「赛博虎妞」，帮助用户完成日常任务。\n\n先理解本轮目标与已有约定，再采取小而准确的行动；基于真实状态与验证结果交付，不编造事实。\n\n默认用中文简洁沟通，先结论后证据；对重要取舍说明影响，缺少必要信息时再提问。\n\n保留已有输入、工作和历史；涉及删除、发布、权限或凭据的操作遵守明确授权与项目约定。",
      },
    ],
    comments: [],
  },
  {
    id: "tiger-preferences",
    library: "tiger",
    origin: "automatic",
    title: "近期使用偏好",
    content: "## 沟通\n\n偏好中文直接沟通，先结论后依据。\n\n## 工作方式\n\n所有界面改动均先出单页面 HTML 交互设计稿，经核对后再进入实际代码实现。\n\n## 近期关注\n\n聚焦知识库右上角自动更新与 Git 差异历史记录的设计落地。",
    history: [
      {
        id: "rev-tp-2",
        timestamp: "今天 08:30",
        author: "系统记忆服务 · 自动整理",
        summary: "提取单页面 HTML 设计稿偏好",
        source: "auto",
        title: "近期使用偏好",
        content: "## 沟通\n\n偏好中文直接沟通，先结论后依据。\n\n## 工作方式\n\n所有界面改动均先出单页面 HTML 交互设计稿，经核对后再进入实际代码实现。\n\n## 近期关注\n\n聚焦知识库右上角自动更新与 Git 差异历史记录的设计落地。",
      },
      {
        id: "rev-tp-1",
        timestamp: "昨天 08:30",
        author: "系统记忆服务 · 自动整理",
        summary: "初始偏好提取",
        source: "auto",
        title: "近期使用偏好",
        content: "## 沟通\n\n偏好中文沟通，结论放在前面。\n\n## 工作方式\n\n界面改动前，先看设计稿再进入具体实现。\n\n## 近期关注\n\n关注知识库的文档阅读与员工信息展示。",
      },
    ],
    comments: [
      {
        id: "c-tp-1",
        author: "用户",
        timestamp: "今天 08:40",
        text: "聚焦单页面 HTML 设计稿和知识库右上角自动更新。",
        applied: true,
        appliedInRev: "rev-tp-2",
      },
      {
        id: "c-tp-2",
        author: "用户",
        timestamp: "刚刚",
        text: "每个文档支持在底部进行评论，下次生成时把评论作为要求提供给生成 Agent。",
        applied: false,
      },
    ],
  },
  {
    id: "tiger-design",
    library: "tiger",
    origin: "conversation",
    title: "先看设计，再实现",
    content: "涉及重要界面改动时，先查看现有实现并提供针对性的设计稿；确认方向后再进入正式实现。\n\n设计稿包含主要页面、关键交互与可查看的预览。",
    history: [
      {
        id: "rev-td-1",
        timestamp: "3天前 14:00",
        author: "对话保存 · 赛博虎妞",
        summary: "保存先出设计稿再实现的约定",
        source: "manual",
        title: "先看设计，再实现",
        content: "涉及重要界面改动时，先查看现有实现并提供针对性的设计稿；确认方向后再进入正式实现。\n\n设计稿包含主要页面、关键交互与可查看的预览。",
      },
    ],
    comments: [],
  },
  {
    id: "tiger-proof",
    library: "tiger",
    origin: "manual",
    title: "完成前核对实际效果",
    content: "交付前按用户实际操作路径核对结果。\n\n对于尚未验证的设备或场景，保留清楚的说明。",
    history: [
      {
        id: "rev-tp2-1",
        timestamp: "4天前 18:20",
        author: "用户",
        summary: "交付前核对规范",
        source: "manual",
        title: "完成前核对实际效果",
        content: "交付前按用户实际操作路径核对结果。\n\n对于尚未验证的设备或场景，保留清楚的说明。",
      },
    ],
    comments: [],
  },
  {
    id: "designer-role",
    library: "designer",
    origin: "ai-draft",
    title: "角色设定",
    role: true,
    content: "你是产品设计伙伴，帮助用户把想法整理为可评审的界面方案。\n\n## 工作方式\n\n先理解用户目标与现有使用流程，再给出结构、内容层级与关键状态。\n\n## 交付方式\n\n提供可点击的设计稿，说明主要交互及失败、空状态与窄屏布局。",
    history: [
      {
        id: "rev-dr2-1",
        timestamp: "5天前 10:15",
        author: "HR 起草 · 用户确认",
        summary: "招聘时生成的角色设定",
        source: "ai",
        title: "角色设定",
        content: "你是产品设计伙伴，帮助用户把想法整理为可评审的界面方案。\n\n## 工作方式\n\n先理解用户目标与现有使用流程，再给出结构、内容层级与关键状态。\n\n## 交付方式\n\n提供可点击的设计稿，说明主要交互及失败、空状态与窄屏布局。",
      },
    ],
    comments: [],
  },
];

function changeView(action: () => void) {
  if (document.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    document.startViewTransition(() => flushSync(action));
  } else action();
}

function App() {
  const [documents, setDocuments] = React.useState<Document[]>(initialDocuments);
  const [selectedId, setSelectedId] = React.useState("tiger-preferences");
  const [expanded, setExpanded] = React.useState<React.Key[]>([
    "group-global", "group-project", "library-wand", "group-employee", "library-tiger",
  ]);
  const [query, setQuery] = React.useState("");
  const [draft, setDraft] = React.useState<Document | null>(null);
  const [pending, setPending] = React.useState<(() => void) | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [invalid, setInvalid] = React.useState(false);
  const [preview, setPreview] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createLibrary, setCreateLibrary] = React.useState("wand");
  const [mobileReading, setMobileReading] = React.useState(false);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [updating, setUpdating] = React.useState(false);
  const [justUpdatedNotice, setJustUpdatedNotice] = React.useState<string | null>(null);
  const [reviewChange, setReviewChange] = React.useState<ReviewChange | null>(null);
  const [editModalOpen, setEditModalOpen] = React.useState(false);

  const scroll = React.useRef<HTMLDivElement>(null);
  const commentInputRef = React.useRef<HTMLTextAreaElement>(null);
  const createTrigger = React.useRef<HTMLButtonElement>(null);

  const active = documents.find(doc => doc.id === selectedId) || documents[0];
  const shown = draft ?? active;
  const owner = libraries.find(item => item.id === shown.library)!;
  const automatic = shown.origin === "automatic";
  const origin = shown.origin ?? "unknown";
  const usageKind = automatic ? 4 : shown.role ? 3 : owner.group === "全局" ? 0 : owner.group === "项目" ? 1 : 2;

  const dirty = !!draft && (
    draft.id.startsWith("draft-") ||
    draft.title !== active.title ||
    draft.content !== active.content ||
    draft.library !== active.library
  );

  const reset = () => {
    setDraft(null);
    setReviewChange(null);
    setHistoryOpen(false);
    setSaved(false);
    setInvalid(false);
    setPreview(false);
  };

  const guard = (action: () => void) => {
    setCreateOpen(false);
    if (dirty) setPending(() => action);
    else { reset(); changeView(action); }
  };

  const choose = (id: string) => guard(() => {
    setSelectedId(id);
    setReviewChange(null);
    setHistoryOpen(false);
    setMobileReading(true);
    scroll.current?.scrollTo({ top: 0 });
  });

  usePopupDismiss(createOpen, () => {
    setCreateOpen(false);
    createTrigger.current?.focus({ preventScroll: true });
  });

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (createOpen) { setCreateOpen(false); return; }
      if (historyOpen) { setHistoryOpen(false); return; }
      if (reviewChange) { setReviewChange(null); return; }
      if (pending) { setPending(null); return; }
      if (draft) { guard(() => setDraft(null)); return; }
      setMobileReading(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [createOpen, historyOpen, reviewChange, pending, draft, dirty]);

  const normalized = query.trim().toLocaleLowerCase();
  const matching = documents.filter(doc =>
    [doc.title, doc.content, libraries.find(lib => lib.id === doc.library)!.name]
      .join("\n").toLocaleLowerCase().includes(normalized),
  );

  const documentNode = (doc: Document): TreeDataNode => ({
    key: doc.id,
    title: <span data-document={doc.id}>{doc.title}</span>,
    icon: <WandIcon name="file" size={15}/>,
    isLeaf: true,
  });

  const libraryNode = (id: string): TreeDataNode => {
    const lib = libraries.find(item => item.id === id)!;
    return {
      key: `library-${id}`,
      title: lib.name,
      selectable: false,
      icon: <WandIcon name={lib.icon} size={15}/>,
      children: matching.filter(doc => doc.library === id).map(documentNode),
    };
  };

  const tree: TreeDataNode[] = [
    {
      key: "group-global",
      title: "全局",
      selectable: false,
      icon: <WandIcon name="server" size={15}/>,
      children: matching.filter(doc => doc.library === "global").map(documentNode),
    },
    {
      key: "group-project",
      title: "项目",
      selectable: false,
      icon: <WandIcon name="folders" size={15}/>,
      children: ["wand", "design"].filter(id => !query || matching.some(doc => doc.library === id)).map(libraryNode),
    },
    {
      key: "group-employee",
      title: "员工",
      selectable: false,
      icon: <WandIcon name="users" size={15}/>,
      children: ["tiger", "designer"].filter(id => !query || matching.some(doc => doc.library === id)).map(libraryNode),
    },
  ].filter(item => !query || item.children.length);

  const allKeys = ["group-global", "group-project", "group-employee", ...libraries.map(item => `library-${item.id}`)];

  const newDocument = () => guard(() => {
    setCreateOpen(false);
    setMobileReading(true);
    setQuery("");
    setExpanded(allKeys);
    scroll.current?.scrollTo({ top: 0 });
    setDraft({
      id: `draft-${documents.length}`,
      library: createLibrary,
      origin: "manual",
      title: "",
      content: "",
      history: [],
      comments: [],
    });
  });

  const save = () => {
    if (!draft || saved) return;
    if (!draft.title.trim() || !draft.content.trim()) { setInvalid(true); return; }
    const nowStamp = "刚刚";
    const newRev: DocumentRevision = {
      id: `rev-${Date.now()}`,
      timestamp: nowStamp,
      author: "用户",
      summary: draft.id.startsWith("draft-") ? "新建文档" : "保存修改",
      source: "manual",
      title: draft.title,
      content: draft.content,
    };
    const entry: Document = {
      ...draft,
      id: draft.id.replace("draft-", "preview-"),
      history: [newRev, ...active.history],
    };
    setDocuments(items => items.some(item => item.id === entry.id)
      ? items.map(item => item.id === entry.id ? entry : item)
      : [...items, entry]);
    setSelectedId(entry.id);
    setDraft(entry);
    setSaved(true);
    setInvalid(false);
  };

  /** Comment handlers: add and delete */
  const handleAddComment = (text: string, mention?: MentionTarget) => {
    const newComment: DocumentComment = {
      id: `c-${Date.now()}`,
      author: "用户",
      timestamp: "刚刚",
      text,
      applied: false,
      mention,
    };
    setDocuments(docs => docs.map(doc => {
      if (doc.id === active.id) {
        return { ...doc, comments: [...doc.comments, newComment] };
      }
      return doc;
    }));
  };

  const handleDeleteComment = (commentId: string) => {
    setDocuments(docs => docs.map(doc => {
      if (doc.id === active.id) {
        return { ...doc, comments: doc.comments.filter(c => c.id !== commentId) };
      }
      return doc;
    }));
  };

  /** Auto update handler: reads pending comments as requirements for the agent! */
  const handleAutoUpdate = () => {
    if (updating) return;
    setUpdating(true);
    const pendingComments = active.comments.filter(c => !c.applied);

    setTimeout(() => {
      const mentionList = pendingComments.filter(c => c.mention).map(c => `@${c.mention!.employeeName} (${c.mention!.provider} · ${c.mention!.model} · 思考:${c.mention!.thinkingEffort})`);
      const agentLine = mentionList.length > 0 ? `*由 ${[...new Set(mentionList)].join("、")} 负责执行生成。*\n\n` : "";

      const requirementsBullet = pendingComments.length > 0
        ? `\n\n## 用户补充要求（已吸收生效）\n${agentLine}` + pendingComments.map(c => `- ${c.text}${c.mention ? `（指派 @${c.mention.employeeName} · ${c.mention.provider}）` : ""}`).join("\n")
        : "";

      const updatedContent = "## 沟通\n\n偏好中文直接沟通，先结论后依据；避免过度包装与表面关键词推测。\n\n## 工作方式\n\n所有界面改动均先出单页面 HTML 交互设计稿，经核对后再进入实际代码实现。\n\n## 近期关注\n\n聚焦知识库右上角自动更新与 Git 差异历史记录的设计落地，保持目录与正文干净清晰。" + requirementsBullet;

      const newRevId = `rev-auto-${Date.now()}`;
      const newRev: DocumentRevision = {
        id: newRevId,
        timestamp: "刚刚 · 自动更新",
        author: pendingComments.some(c => c.mention) ? `@${pendingComments.find(c => c.mention)!.mention!.employeeName}` : "系统记忆服务",
        summary: pendingComments.length > 0
          ? `自动更新（吸收了 ${pendingComments.length} 条评论要求）`
          : "自动整理最新使用偏好",
        source: "auto",
        title: active.title,
        content: updatedContent,
      };

      setDocuments(docs => docs.map(doc => {
        if (doc.id === active.id) {
          return {
            ...doc,
            content: updatedContent,
            history: [newRev, ...doc.history],
            comments: doc.comments.map(c => c.applied ? c : { ...c, applied: true, appliedInRev: newRevId }),
          };
        }
        return doc;
      }));
      setUpdating(false);
      setJustUpdatedNotice(pendingComments.length > 0
        ? `已完成自动更新：已将 ${pendingComments.length} 条评论作为要求交给 Agent 并生成新版本`
        : "已完成自动更新，当前正文为最新生成版本");
      setTimeout(() => setJustUpdatedNotice(null), 4000);
      scroll.current?.scrollTo({ top: 0, behavior: "smooth" });
    }, 450);
  };

  const wordCount = shown.content.replace(/\s/g, "").length;

  return <main className="mockup-page">
    <div className="mockup-label">
      <span>Wand · 知识库设计稿</span>
      <span>单页面 HTML · 钉钉式目录正文 + 自动更新 + Git Diff 历史记录</span>
    </div>

    <section className={`knowledge-app ${mobileReading ? "show-reading" : "show-directory"}`}>
      {/* 侧边导航栏 */}
      <nav className="app-rail" aria-label="应用导航">
        <WandBrandMark className="rail-brand"/>
        {([
          ["chat", "会话"], ["file", "知识库"], ["board", "任务"], ["users", "团队"], ["calendar", "定时"],
        ] as Array<[WandIconName, string]>).map(([icon, label]) => <button
          key={label}
          aria-label={label}
          aria-current={label === "知识库" ? "page" : undefined}
          disabled={label !== "知识库"}
          className={label === "知识库" ? "active" : ""}
          onClick={() => setMobileReading(false)}
        >
          <WandIcon name={icon} size={19}/>
          <span>{label}</span>
        </button>)}
        <div className="rail-gap"/>
        <span className="rail-settings">
          <WandIcon name="gear" size={18}/>
          <small>设置</small>
        </span>
      </nav>

      {/* 知识库左侧目录栏 */}
      <aside className="library-directory" aria-label="知识库目录">
        <header className="directory-heading">
          <h1>知识库</h1>
          <Popover
            open={createOpen}
            onOpenChange={open => { setCreateOpen(open); if (open) setCreateLibrary(owner.id); }}
            trigger="click"
            placement="bottomLeft"
            arrow={false}
            content={
              <div className="create-menu">
                <h3>新建文档</h3>
                <label>保存到</label>
                <WandSelect
                  ariaLabel="新文档保存位置"
                  value={createLibrary}
                  options={libraries.map(lib => ({ value: lib.id, label: lib.name, group: lib.group }))}
                  onValueChange={setCreateLibrary}
                />
                <WandButton kind="primary" onClick={newDocument}>创建文档</WandButton>
                <small>设计预览中的修改仅保留在本页</small>
              </div>
            }
          >
            <WandIconButton ref={createTrigger} aria-label="新建文档" title="新建文档">
              <WandIcon name="plus" size={18}/>
            </WandIconButton>
          </Popover>
        </header>

        <div className="directory-search">
          <WandSearchField
            label="搜索知识库"
            placeholder="搜索知识库"
            value={query}
            onValueChange={value => { setQuery(value); setCreateOpen(false); }}
          />
        </div>

        <div className="directory-caption">
          <span>{query ? `${matching.length} 个结果` : "目录"}</span>
          <WandIconButton
            aria-label={expanded.length ? "收起全部目录" : "展开全部目录"}
            title={expanded.length ? "收起全部目录" : "展开全部目录"}
            onClick={() => setExpanded(expanded.length ? [] : allKeys)}
          >
            <WandIcon name="layers" size={14}/>
          </WandIconButton>
        </div>

        <div className="document-tree">
          {tree.length ? (
            <Tree
              treeData={tree}
              showIcon
              blockNode
              selectedKeys={[selectedId]}
              expandedKeys={query ? allKeys : expanded}
              autoExpandParent={false}
              onExpand={keys => setExpanded(keys)}
              onSelect={(keys, info) => { if (info.node.isLeaf && keys[0]) choose(String(keys[0])); }}
              onClick={(_event, node) => {
                if (!node.isLeaf && !query) {
                  setExpanded(keys => keys.includes(node.key) ? keys.filter(k => k !== node.key) : [...keys, node.key]);
                }
              }}
            />
          ) : (
            <div className="no-results">
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有找到相关文档"/>
              <WandButton kind="ghost" onClick={() => setQuery("")}>清空搜索</WandButton>
            </div>
          )}
        </div>

        <footer className="directory-footer">
          <WandIcon name="file" size={13}/>
          <span>
            {documents.length - documents.filter(doc => doc.role || doc.origin === "automatic").length} 篇知识 ·{" "}
            {documents.filter(doc => doc.role || doc.origin === "automatic").length} 份员工资料
          </span>
        </footer>
      </aside>

      {/* 文档阅读 / 历史记录 / Diff 对比区 */}
      <section className="reader" aria-label="文档阅读区">
        {historyOpen ? (
          <HistoryView
            documentTitle={active.title}
            currentContent={active.content}
            revisions={active.history}
            onClose={() => setHistoryOpen(false)}
            onRestore={rev => {
              setDocuments(docs => docs.map(d => d.id === active.id ? { ...d, content: rev.content } : d));
              setHistoryOpen(false);
              setJustUpdatedNotice(`已恢复至 ${rev.timestamp} 的历史版本`);
              setTimeout(() => setJustUpdatedNotice(null), 4000);
            }}
          />
        ) : reviewChange ? (
          <DiffReview
            change={reviewChange}
            onBack={() => setReviewChange(null)}
            onCancel={() => setReviewChange(null)}
            onApply={() => {
              setDocuments(items => items.map(item => item.id === reviewChange.documentId ? { ...item, title: reviewChange.title, content: reviewChange.after } : item));
              if (draft && draft.id === reviewChange.documentId) {
                setDraft({ ...draft, title: reviewChange.title, content: reviewChange.after });
                setSaved(true);
              }
            }}
          />
        ) : (
          <>
            <header className="document-toolbar">
              <div className="breadcrumbs">
                <WandButton className="mobile-back" kind="ghost" aria-label="返回目录" onClick={() => guard(() => setMobileReading(false))}>
                  <WandIcon name="chevronLeft" size={16}/>目录
                </WandButton>
                <span>{owner.group}</span>
                <span className="slash">/</span>
                <span>{owner.name}</span>
                <span className="slash">/</span>
                <span className="crumb-title">{shown.title || "未命名文档"}</span>
              </div>

              {/* 右上角操作区：自动更新（自动文档专有）、历史记录（所有文档拥有）、编辑、说明 */}
              <div className="document-actions">
                {draft ? (
                  <>
                    <WandButton
                      size="small"
                      disabled={!draft.content || (draft.content === active.content && draft.title === active.title)}
                      onClick={() => setReviewChange({
                        documentId: draft.id,
                        title: draft.title,
                        oldTitle: active.title,
                        before: active.content,
                        after: draft.content,
                        source: "manual",
                      })}
                    >
                      <WandIcon name="git" size={13}/>Git 对比
                    </WandButton>
                    <span className="save-status" role="status">
                      {saved ? "预览内已保存" : dirty ? "未保存" : "编辑中"}
                    </span>
                    <WandButton size="small" onClick={() => guard(() => setDraft(null))}>
                      {saved ? "完成" : "取消"}
                    </WandButton>
                    <WandButton kind="primary" size="small" className="save-button" onClick={save}>
                      {saved ? <><WandIcon name="check" size={13}/>已保存</> : "保存"}
                    </WandButton>
                  </>
                ) : (
                  <>
                    {/* 自动生成的文档：右上角显示「自动更新」按钮，点击直接显示更新后的文档 */}
                    {automatic && (
                      <WandButton
                        size="small"
                        kind="primary"
                        loading={updating}
                        className="auto-update-btn"
                        onClick={handleAutoUpdate}
                      >
                        <WandIcon name="refresh" size={13}/>自动更新
                      </WandButton>
                    )}

                    {/* 所有文档右上角支持「历史记录」按钮 */}
                    <WandButton size="small" onClick={() => setHistoryOpen(true)}>
                      <WandIcon name="history" size={13}/>历史记录
                    </WandButton>

                    {/* 非自动生成文档可手动编辑 */}
                    {!automatic && (
                      <WandButton size="small" onClick={() => setEditModalOpen(true)}>
                        <WandIcon name="edit" size={14}/>{active.role ? "编辑员工资料" : "编辑"}
                      </WandButton>
                    )}

                    {/* 说明入口：注入时机与生成原理 */}
                    <ContentInfo key={shown.id} origin={origin} kind={usageKind} owner={owner.name}/>
                  </>
                )}
              </div>
            </header>

            {pending && (
              <Alert
                className="draft-guard"
                type="warning"
                title="有未保存的修改"
                action={
                  <div>
                    <WandButton size="small" onClick={() => setPending(null)}>继续编辑</WandButton>
                    <WandButton size="small" onClick={() => { const act = pending; reset(); setPending(null); changeView(act); }}>放弃并切换</WandButton>
                  </div>
                }
              />
            )}

            {justUpdatedNotice && (
              <Alert
                className="update-flash-alert"
                type="success"
                showIcon
                message={justUpdatedNotice}
                closable
                onClose={() => setJustUpdatedNotice(null)}
              />
            )}

            <div className="document-scroll" ref={scroll}>
              <article className="document-paper" data-view={draft ? "edit" : automatic ? "automatic" : active.role ? "role" : "document"}>
                {invalid && <Alert type="error" title="请填写标题和正文。输入已保留。" className="validation-error"/>}

                {draft ? (
                  <>
                    <Input
                      aria-label="文档标题"
                      variant="borderless"
                      className="document-title-input"
                      placeholder="文档标题"
                      value={draft.title}
                      readOnly={draft.role}
                      onChange={event => { setDraft({ ...draft, title: event.target.value }); setSaved(false); }}
                    />
                    <div className="editor-meta">
                      <span>{draft.role ? `${owner.name} · 员工资料` : `${owner.name} · 知识文档`}</span>
                      <WandStretchTabs
                        value={preview ? "preview" : "write"}
                        ariaLabel="文档编辑方式"
                        tabs={[{ value: "write", label: "编辑" }, { value: "preview", label: "预览" }]}
                        onValueChange={val => setPreview(val === "preview")}
                      />
                    </div>
                    {preview ? (
                      <MarkdownPreview content={draft.content || "正文将显示在这里。"} variant="inline" wrap/>
                    ) : (
                      <Input.TextArea
                        aria-label="文档正文"
                        variant="borderless"
                        className="document-body-input"
                        placeholder="开始记录…"
                        value={draft.content}
                        autoSize={{ minRows: 16 }}
                        onChange={event => { setDraft({ ...draft, content: event.target.value }); setSaved(false); }}
                      />
                    )}
                  </>
                ) : (
                  <>
                    <h1>{active.title}</h1>
                    <div className="document-meta">
                      <WandIcon name={owner.icon} size={13}/>
                      <span>{owner.name}</span>
                      <span>·</span>
                      <span>{automatic ? "自动整理的近期偏好" : active.role ? "员工资料" : owner.group === "员工" ? "个人知识" : owner.group === "全局" ? "全局知识" : "项目知识"}</span>
                      <span>·</span>
                      <span className="origin-label">{originLabels[origin]}</span>
                      {automatic && <span className="auto-pill">每天自动整理</span>}
                    </div>

                    <MarkdownPreview content={active.content} variant="inline" wrap/>
                  </>
                )}

                <footer className="document-footnote">
                  {automatic
                    ? "仅在启用且未过期时拼入默认员工的角色配置；不会改写已有会话，也不会转存为长期知识。"
                    : shown.role
                    ? "来自员工资料的当前角色设定；已有会话可能保留创建时的版本。"
                    : owner.group === "全局"
                    ? "此文档作为全局约定自动加载。"
                    : owner.group === "项目"
                    ? "此项目的知识目录随绑定会话提供，正文按需读取。"
                    : "此员工的个人知识目录随会话提供，正文按需读取。"}
                </footer>

                {/* 底部评论区：每个文档支持评论，作为下次生成要求的输入 */}
                <CommentsSection
                  comments={active.comments}
                  canAutoUpdate={automatic}
                  inputRef={commentInputRef}
                  onAddComment={handleAddComment}
                  onDeleteComment={handleDeleteComment}
                />
              </article>
            </div>

            <footer className="reader-footer">
              <span>{wordCount} 字</span>
              <span>{automatic ? "自动整理的近期偏好" : shown.role ? "员工角色设定" : "知识文档"}</span>
            </footer>
          </>
        )}
      </section>
    </section>

    {/* 点击「编辑」后弹出的提示框：提示评论区发表即可自动更新，亦可继续手动编辑 */}
    <EditSuggestionDialog
      open={editModalOpen}
      onCancel={() => setEditModalOpen(false)}
      onGoToComments={() => {
        setEditModalOpen(false);
        setTimeout(() => {
          const el = document.querySelector(".document-comments");
          el?.scrollIntoView({ behavior: "smooth", block: "start" });
          commentInputRef.current?.focus({ preventScroll: true });
        }, 60);
      }}
      onContinueManualEdit={() => {
        setEditModalOpen(false);
        setDraft({ ...active });
        setSaved(false);
        setPreview(false);
      }}
    />
  </main>;
}

installReactUiStyles();
createRoot(document.getElementById("root")!).render(
  <WandUiProvider><App/></WandUiProvider>,
);
