import type { CompanionSnapshot } from '../../../shared/contracts';

export function TasksFilesScreen({ snapshot }: { snapshot: CompanionSnapshot | null }) {
  return (
    <section className="screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">Runtime activity</span>
          <h1>Tasks &amp; Files</h1>
          <p>Recent routed work and artifacts returned by the bridge.</p>
        </div>
      </div>
      <div className="split-panels">
        <section className="panel">
          <div className="panel-title">
            <span>Tasks</span>
            <small>{snapshot?.tasks.length ?? 0} recent</small>
          </div>
          <div className="record-list">
            {snapshot?.tasks.length
              ? snapshot.tasks.map((task) => (
                <article className="record" key={task.taskID}>
                  <strong>{task.route || task.taskID}</strong>
                  <span>{task.runtime} · {task.state}</span>
                  {task.progress && <p>{task.progress}</p>}
                </article>
              ))
              : <p className="empty-state">No routed tasks yet.</p>}
          </div>
        </section>
        <section className="panel">
          <div className="panel-title">
            <span>Artifact inbox</span>
            <small>{snapshot?.artifacts.length ?? 0} files</small>
          </div>
          <div className="record-list">
            {snapshot?.artifacts.length
              ? snapshot.artifacts.map((artifact) => (
                <article className="record" key={artifact.artifactID}>
                  <strong>{artifact.displayName}</strong>
                  <span>{artifact.contentType} · {artifact.byteCount.toLocaleString()} bytes</span>
                  <code>{artifact.sha256}</code>
                </article>
              ))
              : <p className="empty-state">No returned files yet.</p>}
          </div>
        </section>
      </div>
    </section>
  );
}
