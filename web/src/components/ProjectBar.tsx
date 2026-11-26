import type { WorkspaceInfo } from '../lib/api';
import type { ProjectLink } from '../types';

interface ProjectBarProps {
  linkedProjects: ProjectLink[];
  activeWorkspaces: WorkspaceInfo[];
  onLinkProject: (ws: WorkspaceInfo) => void;
  onUnlinkProject: (workspaceUri: string) => void;
}

export function ProjectBar({
  linkedProjects,
  activeWorkspaces,
  onLinkProject,
  onUnlinkProject,
}: ProjectBarProps) {
  const linkedUris = new Set(linkedProjects.map((p) => p.workspace_uri));
  const unlinkedActive = activeWorkspaces.filter((ws) => !linkedUris.has(ws.uri));

  if (linkedProjects.length === 0 && unlinkedActive.length === 0) {
    return null;
  }

  return (
    <div className="dn-project-bar" data-testid="dn-project-bar">
      {linkedProjects.map((proj) => (
        <span key={proj.workspace_uri} className="dn-project-chip" title={proj.workspace_uri}>
          <span>📁 {proj.workspace_name}</span>
          <button
            type="button"
            onClick={() => onUnlinkProject(proj.workspace_uri)}
            aria-label={`取消关联 ${proj.workspace_name}`}
            title="取消关联项目"
          >
            ×
          </button>
        </span>
      ))}

      {unlinkedActive.map((ws) => (
        <button
          key={ws.uri}
          type="button"
          className="dn-link-action-btn"
          onClick={() => onLinkProject(ws)}
          title={`将今日笔记关联到项目 ${ws.name}`}
        >
          + 关联项目 {ws.name}
        </button>
      ))}
    </div>
  );
}
