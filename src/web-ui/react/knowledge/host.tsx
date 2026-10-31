import * as React from "react";
import { Alert, Empty, Flex, Input, Spin, Tree } from "antd";
import type { DataNode } from "antd/es/tree";
import { WandButton, WandIconButton } from "../ui/button";
import { WandIcon } from "../ui/icons";
import { WandSearchField } from "../ui/search-field";
import { WandSelect } from "../ui/select";
import { WandTabs } from "../ui/tabs";
import { WandDialog } from "../ui/dialog";
import { MarkdownPreview } from "../file-preview/markdown";
import { installStyleSheet } from "../styles";
import { knowledgeController as controller, knowledgeStore, knowledgeDraftDirty } from "./controller";
import type { KnowledgeDocument, KnowledgeScope } from "./repository";
import { knowledgeStyles } from "./styles";

export interface KnowledgeHostProps { visible: boolean; onOpenSidebar?(): void }
export function KnowledgeHost({ visible, onOpenSidebar }: KnowledgeHostProps): React.ReactElement | null {
  const state = React.useSyncExternalStore(knowledgeStore.subscribe, knowledgeStore.getSnapshot, knowledgeStore.getSnapshot);
  const [confirm, setConfirm] = React.useState<{ kind: "discard"; action(): void } | { kind: "delete"; entry: KnowledgeDocument } | null>(null);
  const [preview, setPreview] = React.useState(false);
  const scroll = React.useRef<HTMLDivElement>(null);
  const titleInput = React.useRef<React.ComponentRef<typeof Input.TextArea>>(null);
  const bodyInput = React.useRef<React.ComponentRef<typeof Input.TextArea>>(null);
  const titleInvalid = state.validationFailed && !state.draft?.title.trim();
  const bodyInvalid = state.validationFailed && !state.draft?.content.trim();
  const focusInvalid = (): void => { (titleInvalid ? titleInput : bodyInvalid ? bodyInput : null)?.current?.focus({ preventScroll: true }); };
  React.useInsertionEffect(() => { installStyleSheet("wand-knowledge-styles", knowledgeStyles); }, []);
  React.useEffect(() => { if (visible && state.open) void controller.load(); }, [visible, state.open, state.scope, state.ownerId]);
  React.useEffect(() => { setPreview(false); scroll.current?.scrollTo({ top: 0 }); }, [state.scope, state.ownerId, state.selectedId]);
  React.useEffect(() => { if (!visible) setConfirm(null); }, [visible]);
  React.useEffect(() => { setConfirm(null); }, [state.scope, state.ownerId, state.selectedId]);
  React.useEffect(() => { if (state.error && !state.validationFailed) scroll.current?.scrollTo({ top: 0, behavior: "instant" }); }, [state.error, state.validationFailed]);
  React.useEffect(() => {
    if (!state.validationFailed) return;
    if (bodyInvalid && preview) { setPreview(false); return; }
    focusInvalid();
  }, [state.validationFailed, preview]);
  if (!state.open) return null;
  const entries = state.library?.entries ?? [];
  const selected = entries.find(entry => entry.id === state.selectedId);
  const owners = state.scope === "global" ? (state.owners?.global ? [state.owners.global] : []) : state.scope === "personal" ? state.owners?.employees : state.owners?.projects;
  const syncErrors = state.library?.cliSync?.filter(result => result.error) ?? [];
  const ownerName = state.library?.ownerName || owners?.find(owner => owner.id === state.ownerId)?.name || "知识库";
  const filtered = entries.filter(entry => `${entry.title}\n${entry.content}\n${entry.folder}`.toLocaleLowerCase().includes(state.query.trim().toLocaleLowerCase()));
  const folders = [...new Set(filtered.map(entry => entry.folder || "未分类"))];
  const tree: DataNode[] = folders.map(folder => ({ key: `folder:${folder}`, title: folder, selectable: false, icon: <WandIcon name="folder" size={14}/>, children: filtered.filter(entry => (entry.folder || "未分类") === folder)
    .map(entry => ({ key: entry.id, title: entry.title, icon: <WandIcon name="file" size={14}/> })) }));
  const guard = (action: () => void): void => {
    if (state.busy) return;
    if (knowledgeDraftDirty(state.draft)) setConfirm({ kind: "discard", action });
    else { controller.discard(); action(); }
  };
  const switchScope = (scope: KnowledgeScope): void => { if (scope !== state.scope) guard(() => controller.open(scope, "")); };
  const latest = state.conflict && state.draft ? entries.find(entry => entry.id === state.draft?.id && entry.revision !== state.draft.revision) : null;
  const writable = !!state.library && !state.library.readOnly;
  return <section aria-label="知识库" className={`wand-knowledge-page ${state.mobileDocument ? "show-document" : "show-directory"}`}
    style={{ display: visible ? undefined : "none" }} inert={!visible} aria-hidden={!visible}>
    <aside className="knowledge-directory" aria-label="知识库目录">
      <div className="directory-title"><Flex align="center" gap={8}>{onOpenSidebar && <WandIconButton aria-label="打开导航" onClick={onOpenSidebar}><WandIcon name="rail"/></WandIconButton>}<h1>知识库</h1></Flex>
        <WandIconButton aria-label="新建文档" title="新建文档" disabled={!writable || state.busy || entries.length >= (state.library?.limit ?? 200)} onClick={() => guard(() => controller.edit())}><WandIcon name="plus" size={18}/></WandIconButton></div>
      <WandTabs className="knowledge-tabs" ariaLabel="知识库范围" value={state.scope} onValueChange={value => switchScope(value as KnowledgeScope)} tabs={[
        { value: "global", label: "全局", content: null, disabled: state.busy },
        { value: "project", label: "项目", content: null, disabled: state.busy }, { value: "personal", label: "个人", content: null, disabled: state.busy },
      ]}/>
      <div className="directory-tools">{state.scope === "global" ? <span>所有员工、项目与 CLI</span> : <WandSelect value={state.ownerId} options={(owners ?? []).map(owner => ({ value: owner.id, label: owner.name }))}
        ariaLabel={state.scope === "personal" ? "选择员工" : "选择项目"} placeholder={state.scope === "personal" ? "选择员工" : "选择项目"} searchable disabled={state.busy || !owners?.length}
        onValueChange={id => { if (id !== state.ownerId) guard(() => controller.open(state.scope, id)); }}/>}
        <WandSearchField label="搜索当前知识库" placeholder="搜索文档…" value={state.query} onValueChange={query => controller.search(query)}/></div>
      <div className="directory-caption"><span>{state.query ? `${filtered.length} 篇匹配` : `${entries.length} 篇文档`}</span><WandIconButton aria-label="刷新知识库" title="刷新知识库" disabled={state.loading || state.busy} onClick={() => void controller.load()}><WandIcon name="refresh" size={14}/></WandIconButton></div>
      <div className="document-tree" aria-busy={state.loading}>{state.loading && !state.library ? <Flex justify="center" role="status" gap={8}><Spin size="small"/>正在读取…</Flex>
        : tree.length ? <Tree key={`${state.scope}:${state.ownerId}:${state.query}:${folders.join("\u0000")}`} treeData={tree} defaultExpandAll showIcon blockNode selectedKeys={state.selectedId ? [state.selectedId] : []}
          onSelect={(_keys, info) => { if (info.node.selectable === false) return; const id = String(info.node.key); if (id === state.selectedId) controller.select(id); else guard(() => controller.select(id)); }}/>
        : <div className="directory-empty"><span>{state.query ? "没有匹配的文档" : state.error ? "暂时无法读取知识库" : owners?.length ? "这个知识库还没有文档" : state.scope === "project" ? "创建项目后即可整理项目知识" : "还没有可用的员工"}</span>
          {state.query ? <WandButton size="small" onClick={() => controller.search("")}>清除搜索</WandButton> : writable && !state.error ? <WandButton size="small" onClick={() => guard(() => controller.edit())}>新建第一篇文档</WandButton> : null}</div>}
      </div>
      {state.error && !state.mobileDocument ? <Alert type="error" showIcon role="alert" title={state.error} action={<WandButton size="small" disabled={state.loading || state.busy} onClick={() => void controller.load()}>重试</WandButton>}/> : null}
      <div className="library-note"><WandIcon name={state.scope === "personal" ? "lock" : "folder"} size={14}/><p>{state.scope === "global" ? "全局约定自动用于所有对话。默认安装同步各 CLI 的全局规则；现有终端会话可能需要重开。完整加载，合计最多 24 KB。" : state.scope === "personal" ? "每位员工拥有自己的知识库。在对话里说「记住」，就会写入这位员工的知识库。" : "项目约定集中保存在这里。在项目对话中明确说「记到项目知识库」，即可保存。"}</p></div>
    </aside>
    <article className="knowledge-document" aria-label="知识文档">
      <div className="document-bar"><div className="document-location"><WandButton className="directory-back" kind="ghost" onClick={() => controller.directory()}><WandIcon name="chevronLeft"/>目录</WandButton><span>{ownerName}</span><span className="breadcrumb-divider">/</span><span>{state.draft?.folder || selected?.folder || "未分类"}</span></div>
        <div className="document-actions">{state.draft ? <><WandButton disabled={state.busy} onClick={() => guard(() => controller.discard())}>取消</WandButton><WandButton className="knowledge-save-button" kind="primary" disabled={!writable || state.busy || state.loading || !knowledgeDraftDirty(state.draft)} onClick={() => { focusInvalid(); void controller.save(); }}>{state.busy ? "保存中…" : "保存"}</WandButton></> : selected ? <>
          <WandIconButton aria-label="删除文档" title="删除文档" disabled={state.busy} onClick={() => setConfirm({ kind: "delete", entry: selected })}><WandIcon name="trash" size={16}/></WandIconButton>
          {writable && <WandButton disabled={state.busy || state.loading} onClick={() => controller.edit(selected)}><WandIcon name="edit" size={14}/>编辑</WandButton>}</> : null}</div></div>
      <div className="document-scroll" ref={scroll}><div className="document-paper">
        {state.error ? <Alert id="knowledge-document-error" className="document-error" type="error" showIcon role="alert" title={state.error} description={state.conflict ? "文档已在其他地方更新，草稿已保留。请读取最新版本，核对后合并。" : state.validationFailed ? undefined : state.draft ? "输入已保留。保存结果不明时，请先刷新确认再重试。" : undefined}
          action={state.validationFailed ? undefined : <WandButton size="small" disabled={state.loading || state.busy} onClick={() => void controller.load()}>重新读取</WandButton>}/> : null}
        {syncErrors.length ? <Alert className="document-error" type="warning" showIcon title="知识已保存，部分 CLI 尚未同步" description={syncErrors.map(result => `${result.provider}：${result.error}`).join("；")}/> : null}
        {state.library?.readOnly ? <Alert className="document-error" type="info" title="项目已移除，保留的知识仍可阅读或删除。"/> : null}
        {state.draft ? <>
          <div className="document-state" role="status">{state.notice || (knowledgeDraftDirty(state.draft) ? "有未保存的修改" : "编辑文档")}</div>
          {latest && <details className="knowledge-conflict"><summary>查看最新版本并合并</summary><h2>{latest.title}</h2><MarkdownPreview content={latest.content} variant="inline" wrap/><WandButton onClick={() => controller.acceptLatestRevision()}>已核对，保留草稿继续编辑</WandButton></details>}
          <Input.TextArea ref={titleInput} className="document-title-input" aria-label="文档标题" aria-invalid={titleInvalid || undefined} aria-describedby={titleInvalid ? "knowledge-document-error" : undefined} placeholder="文档标题" value={state.draft.title} maxLength={100} autoSize variant="borderless" disabled={state.busy} onChange={event => controller.change({ title: event.target.value })}/>
          <Flex className="knowledge-editor-tools" wrap align="center" justify="space-between" gap={12}><label>目录<Input aria-label="文档目录" placeholder="未分类" value={state.draft.folder} maxLength={100} disabled={state.busy} onChange={event => controller.change({ folder: event.target.value })}/></label>
            <WandButton size="small" aria-pressed={preview} onClick={() => setPreview(value => !value)}>{preview ? "继续编辑" : "预览正文"}</WandButton></Flex>
          <span className="editor-hint">{state.scope === "global" ? "适合保存所有对话都应遵守的约定，例如浏览器工具选择。保存后自动加载，合计最多 24 KB。" : "支持 Markdown，保存后可在对话中使用。"}</span>
          {preview ? <MarkdownPreview content={state.draft.content} variant="inline" wrap/> : <Input.TextArea ref={bodyInput} id="knowledge-document-body" aria-label="文档正文" aria-invalid={bodyInvalid || undefined} aria-describedby={bodyInvalid ? "knowledge-document-error" : undefined} placeholder="写下需要长期记住的内容…" value={state.draft.content} maxLength={12000} autoSize={{ minRows: 14 }} variant="borderless" disabled={state.busy} onChange={event => controller.change({ content: event.target.value })}/>}
          <div className="document-count">{state.draft.content.length.toLocaleString()} / 12,000</div>
        </> : selected ? <><div className="document-state" role="status">{state.notice || `更新于 ${new Date(selected.updatedAt).toLocaleString()}`}</div><h1>{selected.title}</h1><MarkdownPreview content={selected.content} variant="inline" wrap/>
          <div className="document-footer"><WandIcon name={state.scope === "personal" ? "lock" : "folder"} size={14}/>{state.scope === "global" ? "全局约定：跨员工、项目与 CLI 自动加载。" : state.scope === "personal" ? `仅属于${ownerName}，不会与其他员工共享。` : `属于${ownerName}项目，供项目内的对话参考。`}</div></>
          : <div className="document-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={state.loading ? "正在读取文档…" : state.selectedId ? "这篇文档已不存在" : "让值得记住的内容，有一个固定的地方"}/><p>从目录选择文档，或新建一篇记录项目约定与长期知识。</p>{writable && <WandButton onClick={() => guard(() => controller.edit())}>新建文档</WandButton>}</div>}
      </div></div>
    </article>
    <WandDialog open={!!confirm && visible} title={confirm?.kind === "delete" ? `删除「${confirm.entry.title}」？` : "放弃未保存的修改？"}
      description={confirm?.kind === "delete" ? `此文档将从${ownerName}的知识库删除，无法撤销。` : "当前草稿还没有保存。你可以继续编辑，或放弃后切换。"}
      dismissable={!state.busy} actions={[{ label: "继续保留", value: false, autoFocus: true }, { label: confirm?.kind === "delete" ? "删除文档" : "放弃修改", value: true, kind: "danger" }]}
      onDismiss={() => setConfirm(null)} onAction={yes => { const action = confirm; setConfirm(null); if (!yes || !action) return; if (action.kind === "delete") void controller.remove(action.entry); else { controller.discard(); action.action(); } }}/>
  </section>;
}
