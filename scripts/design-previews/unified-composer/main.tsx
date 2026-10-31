import * as React from "react";
import { createRoot } from "react-dom/client";
import { Flex, Typography } from "antd";
import { WandUiProvider } from "../../../src/web-ui/react/theme";
import { setWandTheme } from "../../../src/web-ui/react/theme-preference";
import { installReactUiStyles } from "../../../src/web-ui/react/styles";
import { installChatComposerStyles } from "../../../src/web-ui/react/chat-composer-styles";
import { installConversationHomeStyles } from "../../../src/web-ui/react/conversations/home-styles";
import { installNewWorkStyles } from "../../../src/web-ui/react/new-session/start-styles";
import { NewWorkComposer, type NewWorkComposerHandle } from "../../../src/web-ui/react/new-session/composer";
import { ConversationExecutionSelectors } from "../../../src/web-ui/react/conversations/execution-preference";
import { ConversationSubmitButton, ConversationMorphIcon } from "../../../src/web-ui/react/conversations/controls";
import { ComposerWorkSummary, ComposerWorkPanel } from "../../../src/web-ui/react/composer-work-panel";
import { ComposerAttachmentList } from "../../../src/web-ui/react/composer-attachments/host";
import { ComposerEmployeeButton } from "../../../src/web-ui/react/composer-sender/employee";
import { useEditorExpansion } from "../../../src/web-ui/react/composer-sender/editor-expansion";
import { pasteFilesInto } from "../../../src/web-ui/react/composer-paste";
import { WandButton, WandIcon, WandIconButton, WandPopover } from "../../../src/web-ui/react/ui";
import type { WandTaskAgent } from "../../../src/task-types";
import type { WandThemeId } from "../../../src/web-ui/react/theme-palettes";
import "./style.css";

installReactUiStyles(); installChatComposerStyles(); installConversationHomeStyles(); installNewWorkStyles();
const variants = ["新建会话", "新建任务", "对话详情", "工作区", "团队消息"];
const models = ["Qwen3.8-Flash", "Claude Sonnet 4.6", "very-long-provider-name/deep-research-model-2026-10-preview"];
function Demo() {
  const [variant, setVariant] = React.useState(variants[0]);
  const [text, setText] = React.useState("");
  const [theme, setTheme] = React.useState<WandThemeId>("graphite");
  const [agent, setAgent] = React.useState<WandTaskAgent>({provider:"claude", engine:"cli", kind:"structured", model:models[0], thinkingEffort:"claude:medium", mode:"managed"});
  const [files, setFiles] = React.useState<Array<{file:File;name:string;size:number;previewUrl:string|null}>>([]);
  const [capsule, setCapsule] = React.useState("");
  const [tools, setTools] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const [phase,setPhase] = React.useState<"idle"|"failed">("idle");
  const [compact,setCompact] = React.useState(false);
  const sender = React.useRef<NewWorkComposerHandle>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const editor = useEditorExpansion("preview", () => sender.current?.inputElement);
  React.useLayoutEffect(()=>{setWandTheme(theme)},[theme]);
  const addFiles = (incoming: File[]) => setFiles(current => [...current,...incoming.slice(0,5-current.length).filter(f=>f.size<=10*1024*1024).map(file=>({file,name:file.name,size:file.size,previewUrl:file.type.startsWith("image/")?URL.createObjectURL(file):null}))]);
  (window as any).composerPreview={setAgent,setText,setPhase,setRunning,setCompact,state:{text,files:files.length,variant,phase,agent}};
  const summaries=[{label:"Todo",count:"2/4",preview:"检查各输入区的对齐与关闭路径",icon:"task" as const},{label:"Agent",count:"2",preview:"1 运行中 · 1 已完成",icon:"users" as const},{label:"待发送",count:"3",preview:"另外检查一下图片粘贴",icon:"history" as const}];
  const send=()=>{setPhase("failed")};
  return <WandUiProvider><main className="composer-preview">
    <header><Typography.Title level={4} style={{margin:0}}>输入区 · 设计预览</Typography.Title><Flex wrap gap={4}>
      {(["graphite","warm","forest"] as WandThemeId[]).map(id=><WandButton key={id} kind={theme===id?"soft":"ghost"} onClick={()=>setTheme(id)}>{({graphite:"深色",warm:"浅色",forest:"森林"})[id]}</WandButton>)}
    </Flex></header>
    <nav><Flex wrap gap={4}>{variants.map(value=><WandButton key={value} kind={variant===value?"soft":"ghost"} onClick={()=>setVariant(value)}>{value}</WandButton>)}</Flex><Flex gap={4}><WandButton kind="ghost" onClick={()=>setCompact(!compact)}>窄容器</WandButton><WandButton kind="ghost" onClick={()=>setAgent({...agent,model:agent.model===models[2]?models[0]:models[2]})}>长模型名</WandButton><WandButton kind="ghost" onClick={()=>setRunning(!running)}>发送 / 停止</WandButton></Flex></nav>
    <section className={`preview-stage conversation-root${compact?" preview-compact":""}`}>
      <div className="preview-message"><Typography.Text>沿用你给的布局，把书写和操作分开。</Typography.Text><Typography.Paragraph type="secondary">这份预览使用实际输入组件。可以输入、粘贴图片、选择配置和展开胶囊；提交只展示本地失败恢复。</Typography.Paragraph></div>
      <div className="preview-composer">
        <div className="composer-top-row">{summaries.map(item=><WandPopover key={item.label} side="top" open={capsule===item.label} onOpenChange={open=>setCapsule(open?item.label:"")} ariaLabel={`${item.label}详情`} className="composer-work-popover" trigger={<ComposerWorkSummary {...item} expanded={capsule===item.label}/>}>
          <ComposerWorkPanel title={item.label} onClose={()=>setCapsule("")}><p style={{margin:16}}>{item.preview}</p><p style={{margin:16}}>详情沿现有业务展示，打开不移动输入区。</p></ComposerWorkPanel>
        </WandPopover>)}</div>
        {phase==="failed"?<div className="preview-feedback" role="status">提交失败，文字和附件保留。<WandButton size="small" kind="ghost" onClick={()=>setPhase("idle")}>关闭</WandButton></div>:null}
        <NewWorkComposer ref={sender} text={text} onTextChange={setText} onSubmit={send} placeholder="随心输入，描述你想完成的事…" expanded={editor.expanded} onPaste={pasteFilesInto(addFiles)}
          header={files.length?<ComposerAttachmentList items={files.map((f,index)=>({...f,index,sizeLabel:`${f.size} B`}))} onRemove={index=>setFiles(current=>current.filter((_,i)=>i!==index))}/>:null}
          footer={<Flex className="conversation-action-row" align="center" justify="space-between"><Flex gap={4} align="center">
            <WandPopover side="top" open={tools} onOpenChange={setTools} ariaLabel="更多操作" trigger={<WandIconButton aria-label="更多操作"><ConversationMorphIcon from="plus" to="close" active={tools}/></WandIconButton>}><Flex vertical gap={8}><div className="composer-editor-menu">{editor.control}</div><WandButton kind="ghost" onClick={()=>{setTools(false);fileInput.current?.click()}}>添加附件</WandButton><div className="composer-menu-runtime"><ConversationExecutionSelectors agent={agent} catalog={null} disabled={false} onChange={next=>setAgent({...agent,...next})}/></div></Flex></WandPopover>
            <WandIconButton aria-label="添加附件" onClick={()=>fileInput.current?.click()}><WandIcon name="paperclip" size={18}/></WandIconButton>
            <WandButton kind="ghost" className="preview-permission new-work-permission" title="沿用已有运行权限" aria-label="运行权限" onClick={()=>setTools(!tools)}><WandIcon name="shield" size={14}/><span>托管执行</span></WandButton>
          </Flex><Flex gap={4} align="center" className="new-work-send-actions"><ComposerEmployeeButton employee={{id:"e_wand_default",name:"赛博虎妞"}} onClick={()=>setTools(!tools)}/><div className="conversation-runtime-summary"><ConversationExecutionSelectors agent={agent} catalog={null} disabled={false} onChange={next=>setAgent({...agent,...next})}/></div><ConversationSubmitButton stops={running} phase={phase} label={running?"停止本轮":variant==="新建任务"?"创建任务":"发送消息"} disabled={!running&&!text.trim()&&!files.length} onClick={()=>running?setRunning(false):send()}/></Flex></Flex>}/>
        <div className="wand-composer-context"><WandButton kind="ghost" className="conversation-directory-trigger" title="/Users/co0ontty/Self/vibe_coding/wand"><WandIcon name="folder" size={14}/>wand<WandIcon name="chevronDown" size={11}/></WandButton><span className="preview-context-tail">{variant}</span></div>
        <input hidden ref={fileInput} type="file" multiple onChange={event=>{addFiles(Array.from(event.currentTarget.files||[]));event.currentTarget.value=""}}/>
      </div>
    </section>
  </main></WandUiProvider>;
}
createRoot(document.getElementById("root")!).render(<Demo/>);
