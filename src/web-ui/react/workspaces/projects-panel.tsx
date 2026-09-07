import * as React from "react";

import { workspacesController, workspacesStore } from "./controller";
import { httpWorkspacesRepository } from "./repository";
import type { Workspace } from "./types";
import { classNames } from "../ui/class-names";
import { WandIcon } from "../ui";

export function ProjectsPanel(): React.ReactElement {
  const [projects, setProjects] = React.useState<Workspace[]>([]);
  const [collapsed, setCollapsed] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");

  const reload = React.useCallback(() => {
    setLoading(true);
    void httpWorkspacesRepository.list()
      .then((items) => { setProjects(items); setError(""); })
      .catch(() => setError("无法加载项目。"))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    reload();
    const timer = window.setInterval(reload, 8_000);
    return () => window.clearInterval(timer);
  }, [reload]);

  const creation = React.useSyncExternalStore(
    workspacesStore.subscribe,
    workspacesStore.getSnapshot,
    workspacesStore.getSnapshot,
  );
  const lastOpenRef = React.useRef(creation.open);
  React.useEffect(() => {
    if (lastOpenRef.current && !creation.open) reload();
    lastOpenRef.current = creation.open;
  }, [creation.open, reload]);

  const openProject = (project: Workspace) => workspacesStore.getRuntime()?.openWorkspace(project);

  return (
    <section className={classNames("projects-panel", collapsed && "is-collapsed")} aria-label="项目">
      <div className="projects-panel-heading">
        <button
          type="button"
          className="projects-panel-heading-toggle"
          aria-expanded={!collapsed}
          aria-controls="projects-panel-content"
          onClick={() => setCollapsed((current) => !current)}
        >
          <WandIcon name="chevron" size={11} className={classNames("projects-panel-chevron", !collapsed && "open")}/>
          <span>项目</span>
          <span className="projects-panel-heading-count">{projects.length}</span>
        </button>
        <button type="button" className="projects-panel-add" onClick={() => workspacesController.open(undefined, "project")} aria-label="新建项目" title="新建项目">
          <WandIcon name="plus" size={14}/>
        </button>
      </div>
      {!collapsed ? <div id="projects-panel-content" className="projects-panel-content">
        {loading && projects.length === 0 ? <div className="projects-panel-state">加载中…</div> : null}
        {error ? <div className="projects-panel-state error">{error}</div> : null}
        {!loading && !error && projects.length === 0 ? (
          <button type="button" className="projects-panel-empty" onClick={() => workspacesController.open(undefined, "project")}>
            <span className="projects-panel-empty-mark"><WandIcon name="folder" size={16}/></span>
            <span>还没有项目</span>
            <small>创建一个项目开始工作</small>
          </button>
        ) : null}
        <div className="projects-panel-list">
          {projects.map((project) => (
            <button key={project.id} type="button" className="projects-panel-item" onClick={() => openProject(project)} title={project.cwd}>
              <span className="projects-panel-item-icon"><WandIcon name="branch" size={15}/></span>
              <span className="projects-panel-item-copy">
                <strong>{project.name}</strong>
                <small>{project.sessionCount ?? 0} 个会话{project.worktreeCount ? ` · ${project.worktreeCount} 个 Worktree` : ""}</small>
              </span>
            </button>
          ))}
        </div>
      </div> : null}
    </section>
  );
}
