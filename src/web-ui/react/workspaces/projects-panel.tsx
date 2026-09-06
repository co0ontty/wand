import * as React from "react";

import { workspacesController, workspacesStore } from "./controller";
import { httpWorkspacesRepository } from "./repository";
import type { Workspace } from "./types";
import { WandIcon } from "../ui";

export function ProjectsPanel(): React.ReactElement {
  const [projects, setProjects] = React.useState<Workspace[]>([]);
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

  const openProject = (project: Workspace) => workspacesStore.getRuntime()?.openWorkspace(project);

  return (
    <div className="projects-panel">
      <div className="projects-panel-heading">
        <span>我的项目</span>
        <button type="button" className="projects-panel-add" onClick={() => workspacesController.open()} aria-label="新建项目" title="新建项目">
          <WandIcon name="plus" size={14}/>
        </button>
      </div>
      {loading && projects.length === 0 ? <div className="projects-panel-state">加载中…</div> : null}
      {error ? <div className="projects-panel-state error">{error}</div> : null}
      {!loading && !error && projects.length === 0 ? (
        <button type="button" className="projects-panel-empty" onClick={() => workspacesController.open()}>
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
    </div>
  );
}
