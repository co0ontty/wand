import { pageSearch, subscribePageRoute, updatePageRoute } from "../../page-route";
import { knowledgeRepository, subscribeKnowledgeChanges, type KnowledgeDocument, type KnowledgeInput, type KnowledgeLibrary, type KnowledgeNamespace, type KnowledgeOwners, type KnowledgeScope } from "./repository";

export interface KnowledgeDraft extends KnowledgeInput { id: string; revision?: number; original: KnowledgeInput | null; generation: number }
export interface KnowledgeSnapshot extends KnowledgeNamespace {
  open: boolean; selectedId: string; mobileDocument: boolean; query: string;
  owners: KnowledgeOwners | null; library: KnowledgeLibrary | null; loading: boolean;
  error: string; busy: boolean; conflict: boolean; notice: string; draft: KnowledgeDraft | null; validationFailed: boolean;
}
const initial: KnowledgeSnapshot = { open: false, scope: "project", ownerId: "", selectedId: "", mobileDocument: false, query: "",
  owners: null, library: null, loading: false, error: "", busy: false, conflict: false, notice: "", draft: null, validationFailed: false };
function namespaceKey(value: KnowledgeNamespace): string { return `${value.scope}:${value.ownerId}`; }
function draftKey(value: KnowledgeNamespace, id: string): string { return `${namespaceKey(value)}:${id || "new"}`; }
function errorText(error: unknown): string { return error instanceof Error ? error.message : "知识库操作失败，请重试。"; }
export function knowledgeDraftDirty(draft: KnowledgeDraft | null): boolean {
  return !!draft && (!draft.original || draft.title !== draft.original.title || draft.content !== draft.original.content || draft.folder !== draft.original.folder);
}

/** One owner for document selection, drafts and request generations. Hidden routes retain drafts in memory. */
export class KnowledgeController {
  private snapshot: KnowledgeSnapshot = { ...initial };
  private listeners = new Set<() => void>();
  private drafts = new Map<string, KnowledgeDraft>();
  private reads = 0;
  private writes = 0;
  constructor(private repository = knowledgeRepository, private route: (patch: Record<string, string | null>, mode?: "push" | "replace") => void = updatePageRoute) {}
  getSnapshot = (): KnowledgeSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<KnowledgeSnapshot>): void { this.snapshot = { ...this.snapshot, ...patch }; this.listeners.forEach(listener => listener()); }
  private rememberDraft(): void {
    if (this.snapshot.draft) this.drafts.set(draftKey(this.snapshot, this.snapshot.draft.id), this.snapshot.draft);
  }
  hasDrafts(): boolean { return [...this.drafts.values(), this.snapshot.draft].some(knowledgeDraftDirty); }
  restore(open: boolean, scope = this.snapshot.scope, ownerId = this.snapshot.ownerId, selectedId = this.snapshot.selectedId): void {
    const previous = this.snapshot;
    this.rememberDraft();
    const changed = namespaceKey(previous) !== namespaceKey({ scope, ownerId });
    if (changed || !open) this.reads++;
    this.publish({ open, scope, ownerId, selectedId, mobileDocument: open && (!previous.open || changed || previous.selectedId !== selectedId) ? !!selectedId : previous.mobileDocument,
      ...(changed ? { library: null, loading: false, query: "", error: "", conflict: false, notice: "", validationFailed: false } : {}),
      draft: this.drafts.get(draftKey({ scope, ownerId }, selectedId)) ?? null,
    });
  }
  open(scope?: KnowledgeScope, ownerId?: string): void {
    const nextScope = scope ?? this.snapshot.scope;
    const nextOwner = ownerId ?? (nextScope === this.snapshot.scope ? this.snapshot.ownerId : "");
    const selectedId = nextScope === this.snapshot.scope && nextOwner === this.snapshot.ownerId ? this.snapshot.selectedId : "";
    this.restore(true, nextScope, nextOwner, selectedId);
    this.route({ view: "knowledge", knowledgeScope: nextScope, knowledgeOwner: nextOwner, knowledgeDocument: selectedId });
  }
  close(): void { if (!this.snapshot.open) return; this.restore(false); this.route({ view: "workspace" }); }
  select(id: string): void {
    this.rememberDraft();
    this.publish({ selectedId: id, mobileDocument: true, draft: this.drafts.get(draftKey(this.snapshot, id)) ?? null, error: "", conflict: false, notice: "", validationFailed: false });
    this.route({ knowledgeDocument: id }, "replace");
  }
  directory(): void { this.publish({ mobileDocument: false }); }
  search(query: string): void { this.publish({ query }); }
  async load(): Promise<void> {
    const token = ++this.reads;
    const namespace = { scope: this.snapshot.scope, ownerId: this.snapshot.ownerId };
    this.publish({ loading: true, error: "", validationFailed: false });
    try {
      const owners = await this.repository.owners();
      if (token !== this.reads) return;
      const candidates = namespace.scope === "global" ? (owners.global ? [owners.global] : []) : namespace.scope === "project" ? owners.projects : owners.employees;
      if (namespace.scope === "global" && !owners.global) throw new Error("服务器尚不支持全局知识库，请更新服务端。");
      if (!namespace.ownerId) namespace.ownerId = candidates[0]?.id ?? "";
      this.publish({ owners, ownerId: namespace.ownerId });
      if (!namespace.ownerId) { this.publish({ library: null, loading: false }); return; }
      if (!candidates.some(owner => owner.id === namespace.ownerId)) {
        this.publish({ library: null });
        throw new Error(namespace.scope === "personal" ? "这位员工已不可用，请选择其他员工。" : "这个项目已不可用，请选择其他项目。");
      }
      const library = await this.repository.list(namespace);
      if (token !== this.reads) return;
      const selectedId = this.snapshot.draft ? this.snapshot.draft.id : this.snapshot.selectedId || library.entries[0]?.id || "";
      this.publish({ library, loading: false, selectedId,
        draft: this.snapshot.draft ?? this.drafts.get(draftKey(namespace, selectedId)) ?? null });
      if (this.snapshot.open) this.route({ knowledgeScope: namespace.scope, knowledgeOwner: namespace.ownerId, knowledgeDocument: selectedId }, "replace");
    } catch (error) {
      if (token === this.reads) {
        const status = (error as { status?: number })?.status;
        this.publish({ loading: false, error: errorText(error), ...(status === 403 || status === 404 ? { library: null } : {}) });
      }
    }
  }
  edit(entry?: KnowledgeDocument): void {
    if (this.snapshot.busy || this.snapshot.library?.readOnly || !this.snapshot.library) return;
    const input = { title: entry?.title ?? "", content: entry?.content ?? "", folder: entry?.folder ?? "" };
    const draft: KnowledgeDraft = { ...input, id: entry?.id ?? "", revision: entry?.revision, original: entry ? input : null, generation: 0 };
    this.publish({ draft, selectedId: entry?.id ?? "", mobileDocument: true, error: "", conflict: false, notice: "", validationFailed: false });
    this.rememberDraft();
  }
  change(patch: Partial<KnowledgeInput>): void {
    if (!this.snapshot.draft || this.snapshot.busy) return;
    const draft = { ...this.snapshot.draft, ...patch, generation: this.snapshot.draft.generation + 1 };
    this.publish({ draft, notice: "", ...(this.snapshot.validationFailed && draft.title.trim() && draft.content.trim() ? { validationFailed: false, error: "" } : {}) });
    this.rememberDraft();
  }
  discard(): void {
    if (this.snapshot.busy) return;
    if (this.snapshot.draft) this.drafts.delete(draftKey(this.snapshot, this.snapshot.draft.id));
    this.publish({ draft: null, error: "", conflict: false, validationFailed: false });
  }
  acceptLatestRevision(): void {
    const draft = this.snapshot.draft;
    const latest = this.snapshot.library?.entries.find(entry => entry.id === draft?.id);
    if (!draft || !latest || latest.revision === draft.revision || this.snapshot.busy) return;
    this.publish({ draft: { ...draft, revision: latest.revision, original: { title: latest.title, content: latest.content, folder: latest.folder }, generation: draft.generation + 1 }, conflict: false, error: "", notice: "已保留草稿，请完成合并后保存。" });
    this.rememberDraft();
  }
  async save(): Promise<void> {
    const state = this.snapshot, draft = state.draft;
    if (!draft || state.busy || !state.library || state.library.readOnly) return;
    if (!draft.title.trim() || !draft.content.trim()) { this.publish({ error: "请填写文档标题和正文。", validationFailed: true }); return; }
    const key = draftKey(state, draft.id), token = ++this.writes;
    this.publish({ busy: true, error: "", conflict: false, notice: "", validationFailed: false });
    try {
      const entry = await this.repository.save({ scope: state.scope, ownerId: state.ownerId }, { title: draft.title, content: draft.content, folder: draft.folder },
        draft.id && draft.revision ? { id: draft.id, revision: draft.revision } : undefined);
      if (this.drafts.get(key)?.generation === draft.generation) this.drafts.delete(key);
      if (token !== this.writes || namespaceKey(state) !== namespaceKey(this.snapshot) || this.snapshot.draft !== draft) return;
      this.publish({ draft: null, selectedId: entry.id, notice: "已保存", library: state.library ? { ...state.library,
        entries: [entry, ...state.library.entries.filter(item => item.id !== entry.id)], total: state.library.total + (state.library.entries.some(item => item.id === entry.id) ? 0 : 1) } : null });
      if (this.snapshot.open) this.route({ knowledgeDocument: entry.id }, "replace");
      if (state.scope === "global") await this.load();
    } catch (error) {
      if (namespaceKey(state) === namespaceKey(this.snapshot) && this.snapshot.draft === draft) this.publish({ error: errorText(error), conflict: (error as { status?: number }).status === 409 });
    } finally {
      if (token === this.writes) {
        this.publish({ busy: false });
        if (this.snapshot.open && this.snapshot.draft !== draft && namespaceKey(state) === namespaceKey(this.snapshot)) void this.load();
      }
    }
  }
  async remove(entry: KnowledgeDocument): Promise<void> {
    if (this.snapshot.busy || namespaceKey(entry) !== namespaceKey(this.snapshot)) return;
    const token = ++this.writes;
    this.publish({ busy: true, error: "", notice: "" });
    try {
      await this.repository.remove(entry);
      this.drafts.delete(draftKey(entry, entry.id));
      if (namespaceKey(entry) !== namespaceKey(this.snapshot)) return;
      const library = this.snapshot.library;
      if (library) this.publish({ library: { ...library, entries: library.entries.filter(item => item.id !== entry.id),
        total: Math.max(0, library.total - (library.entries.some(item => item.id === entry.id) ? 1 : 0)) } });
      if (this.snapshot.selectedId === entry.id) this.publish({ selectedId: "", draft: null, mobileDocument: false, notice: "已删除" });
      await this.load();
    } catch (error) { if (namespaceKey(entry) === namespaceKey(this.snapshot)) this.publish({ error: errorText(error) }); }
    finally { if (token === this.writes) this.publish({ busy: false }); }
  }
}
export const knowledgeController = new KnowledgeController();
export const knowledgeStore = knowledgeController;
let installed = false;
export function installKnowledgeHistory(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const restore = (): void => {
    const params = new URLSearchParams(pageSearch());
    if (params.get("view") !== "knowledge") { knowledgeController.restore(false); return; }
    const scope = params.get("knowledgeScope");
    knowledgeController.restore(true, scope === "global" || scope === "personal" ? scope : "project", params.get("knowledgeOwner") ?? "", params.get("knowledgeDocument") ?? "");
  };
  subscribePageRoute(restore); restore();
  subscribeKnowledgeChanges(namespace => {
    const state = knowledgeStore.getSnapshot();
    if (state.open && !state.busy && namespaceKey(state) === namespaceKey(namespace)) void knowledgeController.load();
  });
  window.addEventListener("beforeunload", event => { if (knowledgeController.hasDrafts()) { event.preventDefault(); event.returnValue = ""; } });
}
