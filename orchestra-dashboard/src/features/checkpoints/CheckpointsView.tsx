import { useCallback, useEffect, useState } from 'react';
import { Bookmark, Bot, FileCode, FolderOpen, GitCommit, GitFork, MessageSquare, Plus, RefreshCw, RotateCcw, UploadCloud } from 'lucide-react';
import type { CheckpointRecord, Project, Task } from '../../app/types';
import { Empty, PageHeader, StateBadge, StatusDot } from '../../shared/ui';
import { formatDate } from '../../shared/format';

export function CheckpointsView({
  project,
  tasks,
  api,
  onLoadPrompt,
  onRetryPush,
  onRetryTask,
}: {
  project: Project | null;
  tasks?: Task[];
  api: <T>(path: string, options?: RequestInit) => Promise<T>;
  onLoadPrompt?: (text: string) => void;
  onRetryPush?: (task: Task) => void;
  onRetryTask?: (task: Task) => void;
}) {
  const [checkpoints, setCheckpoints] = useState<CheckpointRecord[]>([]);
  const [currentHead, setCurrentHead] = useState<string | null>(null);
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<{ text: string; isError: boolean } | null>(null);

  // Manual checkpoint state
  const [manualTitle, setManualTitle] = useState('');
  const [showManualForm, setShowManualForm] = useState(false);

  // Diff drawer state
  const [expandedSha, setExpandedSha] = useState<string | null>(null);
  const [diffDetails, setDiffDetails] = useState<Record<string, { stat: string; patch: string }>>({});
  const [diffLoadingSha, setDiffLoadingSha] = useState<string | null>(null);

  // Branch prompt state
  const [branchingSha, setBranchingSha] = useState<string | null>(null);
  const [branchInput, setBranchInput] = useState('');

  const fetchCheckpoints = useCallback(async () => {
    if (!project) return;
    setLoading(true);
    try {
      const res = await api<{
        checkpoints: CheckpointRecord[];
        currentHead: string | null;
        currentBranch: string | null;
        isDirty: boolean;
      }>(`/api/projects/${project.id}/checkpoints`);
      if (res) {
        setCheckpoints(res.checkpoints || []);
        setCurrentHead(res.currentHead);
        setCurrentBranch(res.currentBranch);
        setIsDirty(res.isDirty);
      }
    } catch (err) {
      console.error('Failed to load checkpoints', err);
    } finally {
      setLoading(false);
    }
  }, [project, api]);

  useEffect(() => {
    void fetchCheckpoints();
  }, [fetchCheckpoints]);

  const handleCreateManual = async () => {
    if (!project || !manualTitle.trim()) return;
    setActionBusy(true);
    setActionMessage({ text: 'Creating snapshot checkpoint…', isError: false });
    try {
      const res = await api<{ ok: boolean; sha: string; title: string }>(`/api/projects/${project.id}/checkpoints/create`, {
        method: 'POST',
        body: JSON.stringify({ message: manualTitle.trim() }),
      });
      if (res?.ok) {
        setActionMessage({ text: `✓ Created checkpoint ${res.sha.slice(0, 7)}!`, isError: false });
        setManualTitle('');
        setShowManualForm(false);
        await fetchCheckpoints();
      }
    } catch (err) {
      setActionMessage({ text: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true });
    } finally {
      setActionBusy(false);
    }
  };

  const handleToggleDiff = async (sha: string) => {
    if (expandedSha === sha) {
      setExpandedSha(null);
      return;
    }
    setExpandedSha(sha);
    if (!diffDetails[sha] && project) {
      setDiffLoadingSha(sha);
      try {
        const res = await api<{ sha: string; stat: string; patch: string }>(`/api/projects/${project.id}/checkpoints/${sha}/diff`);
        if (res) {
          setDiffDetails((prev) => ({ ...prev, [sha]: { stat: res.stat, patch: res.patch } }));
        }
      } catch (err) {
        console.error('Failed to fetch diff', err);
      } finally {
        setDiffLoadingSha(null);
      }
    }
  };

  const handleRevert = async (sha: string, shortSha: string) => {
    if (!project) return;
    const confirm = window.confirm(
      `Rollback project to checkpoint ${shortSha}?\n\nIf you have uncommitted changes, Orchestra will automatically save a backup stash first.`
    );
    if (!confirm) return;

    setActionBusy(true);
    setActionMessage({ text: `Rolling back working tree to ${shortSha}…`, isError: false });
    try {
      const res = await api<{ ok: boolean; sha: string; backupStash: string | null }>(`/api/projects/${project.id}/checkpoints/${sha}/revert`, {
        method: 'POST',
        body: JSON.stringify({ mode: 'rollback' }),
      });
      if (res?.ok) {
        setActionMessage({
          text: `✓ Rolled back to ${shortSha}!${res.backupStash ? ' (Backup stash saved)' : ''}`,
          isError: false,
        });
        await fetchCheckpoints();
      }
    } catch (err) {
      setActionMessage({ text: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true });
    } finally {
      setActionBusy(false);
    }
  };

  const handleCreateBranch = async () => {
    if (!project || !branchingSha || !branchInput.trim()) return;
    setActionBusy(true);
    setActionMessage({ text: `Creating branch ${branchInput} from ${branchingSha.slice(0, 7)}…`, isError: false });
    try {
      const res = await api<{ ok: boolean; branch: string }>(`/api/projects/${project.id}/checkpoints/${branchingSha}/revert`, {
        method: 'POST',
        body: JSON.stringify({ mode: 'branch', branchName: branchInput.trim() }),
      });
      if (res?.ok) {
        setActionMessage({ text: `✓ Created and switched to branch "${res.branch}"!`, isError: false });
        setBranchingSha(null);
        setBranchInput('');
        await fetchCheckpoints();
      }
    } catch (err) {
      setActionMessage({ text: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true });
    } finally {
      setActionBusy(false);
    }
  };

  if (!project) {
    return (
      <section>
        <PageHeader eyebrow="Time-Travel & Version Recovery" title="Checkpoints" subtitle="Revert to previous working states, inspect changes, or fork experimental branches." />
        <Empty icon={<FolderOpen />} title="No Project Selected" text="Select an active project from the sidebar to view its checkpoint timeline and rollback history." />
      </section>
    );
  }

  return (
    <section className="checkpoints-page">
      <PageHeader
        eyebrow="Time-Travel & Version Recovery"
        title="Checkpoints & Revert Timeline"
        subtitle={`Project: ${project.name} · Working directory: ${project.root}`}
        action={
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="secondary" onClick={() => setShowManualForm(!showManualForm)} disabled={actionBusy}>
              <Bookmark size={15} /> {showManualForm ? 'Cancel' : 'New Checkpoint'}
            </button>
            <button className="primary" onClick={fetchCheckpoints} disabled={loading || actionBusy}>
              <RefreshCw size={15} className={loading ? 'spin' : ''} /> Refresh
            </button>
          </div>
        }
      />

      {showManualForm && (
        <div className="manual-checkpoint-bar">
          <input
            type="text"
            placeholder="Describe this manual snapshot (e.g. 'Before refactoring auth module')..."
            value={manualTitle}
            onChange={(e) => setManualTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleCreateManual(); }}
            autoFocus
          />
          <button className="primary compact" onClick={handleCreateManual} disabled={actionBusy || !manualTitle.trim()}>
            <Plus size={14} /> Snapshot Now
          </button>
        </div>
      )}

      {actionMessage && (
        <div className={`action-banner ${actionMessage.isError ? 'error' : 'success'}`}>
          <span>{actionMessage.text}</span>
          <button onClick={() => setActionMessage(null)}>×</button>
        </div>
      )}

      <div className="current-head-banner">
        <div className="head-info">
          <StatusDot ok={!isDirty} />
          <div>
            <strong>Current Branch: <span className="branch-tag">{currentBranch || 'HEAD'}</span></strong>
            <small>HEAD commit: <code>{currentHead?.slice(0, 8) || 'Unknown'}</code> · {isDirty ? '🟡 Uncommitted working tree changes present' : '🟢 Clean working tree'}</small>
          </div>
        </div>
        <div className="head-stats">
          <span>{checkpoints.length} Checkpoints in History</span>
        </div>
      </div>

      <div className="checkpoint-timeline">
        {checkpoints.map((cp, idx) => {
          const isExpanded = expandedSha === cp.sha;
          const isCurrentHead = cp.isHead || cp.sha === currentHead;
          const diff = diffDetails[cp.sha];
          const isLoadingDiff = diffLoadingSha === cp.sha;
          const isBranching = branchingSha === cp.sha;

          return (
            <article key={cp.sha} className={`checkpoint-node ${isCurrentHead ? 'is-head' : ''}`}>
              <div className="timeline-rail">
                <div className={`rail-dot ${isCurrentHead ? 'active-dot' : ''}`}>
                  {isCurrentHead ? <GitCommit size={14} /> : <span className="inner-dot" />}
                </div>
                {idx < checkpoints.length - 1 && <div className="rail-line" />}
              </div>

              <div className="checkpoint-card">
                <header className="checkpoint-card-header">
                  <div className="checkpoint-title-row">
                    {isCurrentHead && <span className="head-pill">CURRENT HEAD</span>}
                    <strong className="checkpoint-message">{cp.message}</strong>
                  </div>
                  <div className="checkpoint-meta-row">
                    <span className="cp-sha"><code>{cp.shortSha}</code></span>
                    <span className="cp-author">{cp.author}</span>
                    <span className="cp-date">{formatDate(cp.date)}</span>
                  </div>
                </header>

                {cp.task && (
                  <div className="checkpoint-task-badge">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span className="task-tag"><Bot size={11} /> Task Prompt:</span>
                      {cp.task.state && <StateBadge state={cp.task.state} />}
                    </div>
                    <p className="task-prompt-text">{cp.task.title}</p>
                    {cp.task.models && <span className="models-tag">{cp.task.models}</span>}
                  </div>
                )}

                {cp.files.length > 0 && (
                  <div className="checkpoint-files-row">
                    <span className="files-count-label">{cp.files.length} file{cp.files.length === 1 ? '' : 's'} modified:</span>
                    <div className="files-chips-list">
                      {cp.files.slice(0, 6).map((f) => (
                        <span key={f.path} className="file-chip" title={f.path}>
                          {f.path.split(/[/\\]/).pop()}
                          <small className="file-stats">+{f.added}/-{f.deleted}</small>
                        </span>
                      ))}
                      {cp.files.length > 6 && <span className="file-chip-more">+{cp.files.length - 6} more</span>}
                    </div>
                  </div>
                )}

                <div className="checkpoint-actions-bar">
                  <div className="primary-actions">
                    {!isCurrentHead && (
                      <button
                        type="button"
                        className="secondary compact revert-btn"
                        onClick={() => handleRevert(cp.sha, cp.shortSha)}
                        disabled={actionBusy}
                        title="Rollback your project to this exact commit"
                      >
                        <RotateCcw size={12} /> Rollback to Here
                      </button>
                    )}
                    <button
                      type="button"
                      className="secondary compact"
                      onClick={() => setBranchingSha(isBranching ? null : cp.sha)}
                      disabled={actionBusy}
                      title="Create a new branch from this checkpoint"
                    >
                      <GitFork size={12} /> Fork Branch
                    </button>
                    <button
                      type="button"
                      className="secondary compact"
                      onClick={() => handleToggleDiff(cp.sha)}
                      disabled={actionBusy}
                    >
                      <FileCode size={12} /> {isExpanded ? 'Hide Diff' : 'View Diff'}
                    </button>
                    {cp.task?.pushStatus === 'unpushed' && onRetryPush && (
                      <button
                        type="button"
                        className="secondary compact"
                        onClick={() => {
                          const match = tasks?.find((t) => t.id === cp.task?.id);
                          if (match) onRetryPush(match);
                        }}
                        disabled={actionBusy}
                        title="Push this commit to origin"
                      >
                        <UploadCloud size={12} /> Retry Push
                      </button>
                    )}
                    {cp.task?.state === 'failed' && onRetryTask && (
                      <button
                        type="button"
                        className="secondary compact"
                        onClick={() => {
                          const match = tasks?.find((t) => t.id === cp.task?.id);
                          if (match) onRetryTask(match);
                        }}
                        disabled={actionBusy}
                        title="Retry failed task"
                      >
                        <RefreshCw size={12} /> Retry Task
                      </button>
                    )}
                  </div>

                  {cp.task?.title && onLoadPrompt && (
                    <button
                      type="button"
                      className="action-link compact"
                      onClick={() => onLoadPrompt(cp.task!.title)}
                      title="Load this prompt back into Tri-Agent chat"
                    >
                      <MessageSquare size={12} /> Load in Chat
                    </button>
                  )}
                </div>

                {isBranching && (
                  <div className="branch-prompt-box">
                    <span>Create new branch from <code>{cp.shortSha}</code>:</span>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <input
                        type="text"
                        placeholder="e.g. experiment-feature-x"
                        value={branchInput}
                        onChange={(e) => setBranchInput(e.target.value)}
                        autoFocus
                      />
                      <button className="primary compact" onClick={handleCreateBranch} disabled={actionBusy || !branchInput.trim()}>
                        Create & Checkout
                      </button>
                      <button className="secondary compact" onClick={() => setBranchingSha(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {isExpanded && (
                  <div className="checkpoint-diff-drawer">
                    {isLoadingDiff ? (
                      <div className="diff-loading"><RefreshCw size={14} className="spin" /> Loading commit diff…</div>
                    ) : diff?.patch ? (
                      <pre className="diff-code-block">{diff.patch}</pre>
                    ) : (
                      <div className="diff-empty">No diff details available for this snapshot.</div>
                    )}
                  </div>
                )}
              </div>
            </article>
          );
        })}

        {!checkpoints.length && (
          <Empty icon={<Bookmark />} title="No Checkpoints Yet" text="Make a commit or run a task to record checkpoints in this project." />
        )}
      </div>
    </section>
  );
}

