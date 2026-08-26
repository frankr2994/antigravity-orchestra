import { useState } from 'react';
import { Bot, CircleAlert, RefreshCw, Server, ShieldCheck, Terminal, Zap } from 'lucide-react';
import type { McpServerRecord } from '../../app/types';
import { Empty, PageHeader, StatusDot } from '../../shared/ui';

export function McpServersView({ servers, busy, onToggle, onRefresh }: { servers: McpServerRecord[]; busy: boolean; onToggle: (id: string, enabled: boolean) => void; onRefresh: () => void }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggleExpand = (id: string) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  const totalTools = servers.filter((s) => s.enabled).reduce((acc, s) => acc + s.toolCount, 0);
  const activeCount = servers.filter((s) => s.enabled && s.operational).length;

  return (
    <section className="mcp-servers-page">
      <PageHeader
        eyebrow="Universal Model Context Protocol Registry"
        title="MCP Servers"
        subtitle="Inspect, probe, and toggle MCP servers across Antigravity, Codex, and Gemma."
        action={
          <button className="primary" onClick={onRefresh} disabled={busy}>
            <RefreshCw size={15} className={busy ? 'spin' : ''} /> Refresh status
          </button>
        }
      />

      <div className="summary-strip">
        <div>
          <strong>{servers.length}</strong>
          <span>Discovered servers</span>
        </div>
        <div>
          <strong>{activeCount}</strong>
          <span>Active & operational</span>
        </div>
        <div>
          <strong>{totalTools}</strong>
          <span>Live tools available</span>
        </div>
      </div>

      <div className="mcp-grid">
        {servers.map((server) => {
          const isExpanded = Boolean(expanded[server.id]);
          const isOk = server.enabled && server.operational;
          return (
            <article key={server.id} className={`mcp-card ${server.enabled ? (server.operational ? 'active' : 'warning-card') : 'disabled-card'}`}>
              <header className="mcp-card-header">
                <div className="mcp-card-title">
                  <StatusDot ok={isOk} />
                  <strong>{server.name}</strong>
                  <span className={`mcp-badge ${server.transportType}`}>
                    {server.transportType === 'http' ? 'HTTP Stream' : 'STDIO Command'}
                  </span>
                </div>
                <button
                  type="button"
                  className={`mcp-toggle-switch ${server.enabled ? 'on' : 'off'}`}
                  onClick={() => onToggle(server.id, !server.enabled)}
                  disabled={busy}
                  title={server.enabled ? 'Click to disable across all models' : 'Click to enable across all models'}
                >
                  <span className="switch-knob" />
                  <span className="switch-label">{server.enabled ? 'ENABLED' : 'DISABLED'}</span>
                </button>
              </header>

              <div className="mcp-card-body">
                <div className="mcp-endpoint-box">
                  <Terminal size={12} />
                  <code>{server.endpoint || server.command || 'stdio process'}</code>
                </div>

                <div className="mcp-metrics-row">
                  <div>
                    <span>Tools</span>
                    <strong>{server.toolCount}</strong>
                  </div>
                  <div>
                    <span>Latency</span>
                    <strong>{server.latencyMs !== null ? `${server.latencyMs}ms` : '—'}</strong>
                  </div>
                  <div>
                    <span>Status</span>
                    <strong className={isOk ? 'text-green' : server.enabled ? 'text-amber' : 'text-muted'}>
                      {server.enabled ? (server.operational ? 'Operational' : 'Unreachable') : 'Disabled'}
                    </strong>
                  </div>
                </div>

                <div className="mcp-models-row">
                  <span className="mcp-models-label">Model Visibility:</span>
                  <div className="mcp-models-badges">
                    <span className={`model-pill ${server.models.antigravity && server.enabled ? 'active' : 'inactive'}`}>
                      <Bot size={10} /> Antigravity
                    </span>
                    <span className={`model-pill ${server.models.codex && server.enabled ? 'active' : 'inactive'}`}>
                      <ShieldCheck size={10} /> Codex
                    </span>
                    <span className={`model-pill ${server.models.gemma && server.enabled ? 'active' : 'inactive'}`}>
                      <Zap size={10} /> Gemma
                    </span>
                  </div>
                </div>

                {server.reason && (
                  <div className="mcp-reason-box">
                    <CircleAlert size={12} />
                    <span>{server.reason}</span>
                  </div>
                )}

                {server.tools.length > 0 && (
                  <div className="mcp-tools-section">
                    <button type="button" className="tools-toggle-btn" onClick={() => toggleExpand(server.id)}>
                      <span>Registered Tools ({server.tools.length})</span>
                      <small>{isExpanded ? 'Hide' : 'Show list'}</small>
                    </button>
                    {isExpanded && (
                      <div className="mcp-tools-list">
                        {server.tools.map((tool) => (
                          <code key={tool} className="tool-chip">{tool}</code>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {!servers.length && (
        <Empty
          icon={<Server />}
          title="No MCP servers found"
          text="Configure MCP servers in ~/.gemini/config/mcp_config.json or ~/.codex/config.toml."
        />
      )}
    </section>
  );
}

