import { useState } from 'react';

import type {
  ArtifactSummary,
  CompanionSnapshot,
  VoiceClawDesktopAPI,
} from '../../../shared/contracts';
import { ConfirmDialog } from '../components/ConfirmDialog';

function displayTime(value: number): string {
  return value > 0 ? new Date(value).toLocaleString() : 'Unknown time';
}

function displaySize(bytes: number): string {
  if (bytes < 1_024) {
    return `${bytes} B`;
  }
  if (bytes < 1_024 * 1_024) {
    return `${(bytes / 1_024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}

interface TasksFilesScreenProps {
  snapshot: CompanionSnapshot | null;
  api: VoiceClawDesktopAPI;
  onRefresh(): Promise<void> | void;
}

export function TasksFilesScreen({
  snapshot,
  api,
  onRefresh,
}: TasksFilesScreenProps) {
  const [deleteTarget, setDeleteTarget] = useState<ArtifactSummary | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [busy, setBusy] = useState(false);

  const deleteArtifact = async () => {
    if (!deleteTarget) {
      return;
    }
    const artifactID = deleteTarget.artifactID;
    setBusy(true);
    setDeleteTarget(null);
    try {
      await api.deleteArtifact(artifactID);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const emptyInbox = async () => {
    setBusy(true);
    setConfirmEmpty(false);
    try {
      await api.emptyArtifactInbox();
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

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
                  <span>{task.runtime} · {task.state} · {displayTime(task.updatedAt)}</span>
                  <dl className="record-details">
                    <div><dt>Progress</dt><dd>{task.progress || '—'}</dd></div>
                    <div><dt>Result</dt><dd>{task.result || '—'}</dd></div>
                    <div><dt>Error</dt><dd>{task.error || '—'}</dd></div>
                  </dl>
                </article>
              ))
              : <p className="empty-state">No routed tasks yet.</p>}
          </div>
        </section>
        <section className="panel">
          <div className="panel-title">
            <span>Artifact inbox</span>
            <div className="panel-title-actions">
              <small>{snapshot?.artifacts.length ?? 0} files</small>
              <button
                className="button button-danger-outline button-compact"
                type="button"
                disabled={busy || !snapshot?.artifacts.length}
                onClick={() => setConfirmEmpty(true)}
              >
                Empty Inbox
              </button>
            </div>
          </div>
          <div className="record-list">
            {snapshot?.artifacts.length
              ? snapshot.artifacts.map((artifact) => (
                <article className="record" key={artifact.artifactID}>
                  <div className="record-heading">
                    <strong>{artifact.displayName}</strong>
                    <button
                      className="button button-danger-outline button-compact"
                      type="button"
                      disabled={busy}
                      aria-label={`Delete ${artifact.displayName}`}
                      onClick={() => setDeleteTarget(artifact)}
                    >
                      Delete
                    </button>
                  </div>
                  <span>{artifact.contentType} · {displaySize(artifact.byteCount)}</span>
                  <span>Task {artifact.taskID} · {displayTime(artifact.createdAt)}</span>
                  <code>{artifact.sha256}</code>
                </article>
              ))
              : <p className="empty-state">No returned files yet.</p>}
          </div>
        </section>
      </div>
      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete artifact"
        confirmLabel="Confirm Delete"
        destructive
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void deleteArtifact()}
      >
        <p>Delete {deleteTarget?.displayName} from the VoiceClaw artifact inbox?</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmEmpty}
        title="Empty artifact inbox"
        confirmLabel="Confirm Empty Inbox"
        destructive
        onCancel={() => setConfirmEmpty(false)}
        onConfirm={() => void emptyInbox()}
      >
        <p>Delete every artifact currently stored in the VoiceClaw inbox?</p>
      </ConfirmDialog>
    </section>
  );
}
