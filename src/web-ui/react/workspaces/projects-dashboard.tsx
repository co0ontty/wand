import * as React from "react";

import { workspacesController, workspacesStore } from "./controller";
import { httpWorkspacesRepository } from "./repository";
import type { Workspace } from "./types";
import { WandIcon } from "../ui";

export function ProjectsDashboard(): React.ReactElement {
  const [projects, setProjects] = React.useState<Workspace[]>([]);
  const [query, setQuery] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    let active = true;
    void httpWorkspacesRepository.list()
      .then((items) => { if (active) { setProjects(items); setError(""); } })
      .catch(() => { if (active) setError("无法加载项目，请稍后重试。"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const filtered = projects.filter((project) => {
    const value = `${project.name} ${project.cwd}`.toLocaleLowerCase();
    return value.includes(query.trim().toLocaleLowerCase());
  });
  const openProject = (project: Workspace) => workspacesStore.getRuntime()?.openWorkspace(project);

  return (
    <section className="projects-dashboard" aria-label="项目">
      <header className="projects-dashboard-hero">
        <div>
          <p className="projects-dashboard-kicker">工作空间</p>
          <h1>项目</h1>
          <p>按项目组织任务、会话和 Worktree，让每一次工作都有清晰的归属。</p>
        </div>
        <div className="projects-dashboard-hero-mark" aria-hidden="true"><WandIcon name="branch" size={42} strokeWidth={1.25}/></div>
      </header>

      <div className="projects-dashboard-toolbar">
        <div><h2>我的项目</h2><span>{projects.length} 个项目</span></div>
        <div className="projects-dashboard-actions">
          <label className="projects-dashboard-search"><WandIcon name="eye" size={15}/><input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="搜索项目" aria-label="搜索项目"/></label>
          <button type="button" className="projects-dashboard-new" onClick={() => workspacesController.open(undefined, "project")}><WandIcon name="plus" size={15}/>新建项目</button>
        </div>
      </div>

      {loading ? <div className="projects-dashboard-state">加载项目中…</div> : null}
      {error ? <div className="projects-dashboard-state error">{error}</div> : null}
      {!loading && !error && filtered.length === 0 ? (
        <div className="projects-dashboard-empty"><span className="projects-dashboard-empty-icon"><WandIcon name="folder" size={22}/></span><strong>{query ? "没有匹配的项目" : "还没有项目"}</strong><span>{query ? "换个关键词试试" : "创建第一个项目，开始组织你的任务"}</span>{!query ? <button type="button" onClick={() => workspacesController.open(undefined, "project")}>＋ 新建项目</button> : null}</div>
      ) : null}
      <div className="projects-dashboard-grid">
        {filtered.map((project) => (
          <button type="button" key={project.id} className="projects-dashboard-card" onClick={() => openProject(project)}>
            <span className="projects-dashboard-card-icon"><WandIcon name="branch" size={18}/></span>
            <span className="projects-dashboard-card-copy"><strong>{project.name}</strong><small>{project.cwd}</small></span>
            <span className="projects-dashboard-card-meta"><span>{project.sessionCount ?? 0} 会话</span><span>{project.worktreeCount ?? 0} Worktree</span></span>
            <WandIcon name="chevronLeft" size={15} className="projects-dashboard-card-arrow"/>
          </button>
        ))}
      </div>
    </section>
  );
}
