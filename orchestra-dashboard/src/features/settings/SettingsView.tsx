import { useCallback, useEffect, useState } from 'react';
import { Activity, Bot, RefreshCw, Square, Terminal, Zap } from 'lucide-react';
import type { AvailableModels, Health, InstalledLmStudioModel, QuotaPolicy, QuotaTierConfig, SettingsData } from '../../app/types';
import { Card, Field, PageHeader, StatusDot } from '../../shared/ui';
import { JulesSettingsCard } from '../jules/JulesSettingsCard';
import { formatGenericModelName } from '../../shared/model-format';

export function SettingsView({
  settings,
  health,
  availableModels,
  api,
  onSave,
}: {
  settings: SettingsData;
  health: Health;
  availableModels?: AvailableModels;
  api: <T>(path: string, options?: RequestInit) => Promise<T>;
  onSave: (value: Partial<SettingsData>) => void;
}) {
  const [interval, setIntervalValue] = useState(settings.telemetryInterval);
  const [localModel, setLocalModel] = useState(settings.lmStudioModel);
  const [installedModels, setInstalledModels] = useState<InstalledLmStudioModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelActionBusy, setModelActionBusy] = useState(false);
  const [actionStatus, setActionStatus] = useState<{ text: string; isError: boolean } | null>(null);

  const [policy, setPolicy] = useState<QuotaPolicy>(settings.quotaPolicy || {
    tierAbove20: { antigravityModel: 'gemini-3.7-flash-high', antigravityEffort: 'high', codexModel: 'gpt-5.6-sol', codexEffort: 'high' },
    tier15to20: { antigravityModel: 'gemini-3.7-flash-high', antigravityEffort: 'high', codexModel: 'gpt-5.6-terra', codexEffort: 'high' },
    tier10to15: { antigravityModel: 'gemini-3.7-flash-medium', antigravityEffort: 'medium', codexModel: 'gpt-5.6-terra', codexEffort: 'medium' },
    tier5to10: { antigravityModel: 'gemini-3.7-flash-low', antigravityEffort: 'low', codexModel: 'gpt-5.6-luna', codexEffort: 'low' },
    tierBelow5: { antigravityModel: 'gemini-3.7-flash-low', antigravityEffort: 'low', codexModel: null, codexEffort: null },
  });

  const fetchInstalledModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      const res = await api<{ models: InstalledLmStudioModel[] }>('/api/lmstudio/models');
      if (res?.models) {
        setInstalledModels(res.models);
        const active = res.models.find((m) => m.state === 'loaded');
        if (active) {
          setLocalModel(active.id);
        } else if (res.models.length > 0) {
          setLocalModel((prev) => prev || res.models[0].id);
        }
      }
    } catch (err) {
      console.error('Failed to fetch installed models', err);
    } finally {
      setModelsLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void fetchInstalledModels();
  }, [fetchInstalledModels]);

  const handleLoadModel = async () => {
    if (!localModel) return;
    setModelActionBusy(true);
    setActionStatus({ text: `Unloading prior models & loading ${localModel} into GPU VRAM…`, isError: false });
    try {
      const res = await api<{ ok: boolean; message: string; activeModel?: string }>('/api/lmstudio/load', {
        method: 'POST',
        body: JSON.stringify({ modelId: localModel, gpu: 'max' }),
      });
      if (res?.ok) {
        setActionStatus({ text: `✓ Loaded ${localModel} successfully!`, isError: false });
        onSave({ lmStudioModel: localModel });
        await fetchInstalledModels();
      } else {
        setActionStatus({ text: `Failed: ${res?.message || 'Error loading model.'}`, isError: true });
      }
    } catch (err) {
      setActionStatus({ text: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true });
    } finally {
      setModelActionBusy(false);
    }
  };

  const handleUnloadModel = async () => {
    setModelActionBusy(true);
    setActionStatus({ text: 'Unloading all local models from VRAM…', isError: false });
    try {
      const res = await api<{ ok: boolean; message: string }>('/api/lmstudio/unload', {
        method: 'POST',
      });
      if (res?.ok) {
        setActionStatus({ text: '✓ 100% VRAM freed! Local models unloaded.', isError: false });
        await fetchInstalledModels();
      } else {
        setActionStatus({ text: `Failed: ${res?.message || 'Error unloading model.'}`, isError: true });
      }
    } catch (err) {
      setActionStatus({ text: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true });
    } finally {
      setModelActionBusy(false);
    }
  };

  const loadedModelCount = installedModels.filter((m) => m.state === 'loaded').length;
  const activeLoadedModel = installedModels.find((m) => m.state === 'loaded');

  const updateTier = (tierKey: keyof QuotaPolicy, field: keyof QuotaTierConfig, value: string | null) => {
    setPolicy((prev) => {
      const updatedTier = { ...prev[tierKey], [field]: value === 'none' ? null : value };
      if (field === 'antigravityModel' && typeof value === 'string') {
        if (/-high\b/i.test(value)) updatedTier.antigravityEffort = 'high';
        else if (/-low\b/i.test(value)) updatedTier.antigravityEffort = 'low';
        else updatedTier.antigravityEffort = 'medium';
      }
      return { ...prev, [tierKey]: updatedTier };
    });
  };

  const tiers: Array<{ key: keyof QuotaPolicy; label: string; badge: string; desc: string }> = [
    { key: 'tierAbove20', label: '> 20% Quota Remaining', badge: 'Normal', desc: 'Full high-capacity frontier tier' },
    { key: 'tier15to20', label: '15% – 20% Quota Remaining', badge: 'Moderate', desc: 'Balanced high capability tier' },
    { key: 'tier10to15', label: '10% – 15% Quota Remaining', badge: 'Conservation', desc: 'Quota preservation with Terra medium' },
    { key: 'tier5to10', label: '5% – 10% Quota Remaining', badge: 'Critical', desc: 'Lightweight models to prevent quota exhaustion' },
    { key: 'tierBelow5', label: '< 5% Quota Remaining', badge: 'Emergency', desc: 'Emergency tier: local triage / bypass Codex' },
  ];

  return (
    <section>
      <PageHeader eyebrow="Local configuration & Quota Management" title="Settings" subtitle="Customize real-time telemetry, model routing, and quota tier policies." />
      <JulesSettingsCard api={api} />
      <div className="settings-grid">
        <Card title="Local model (LM Studio)" icon={<Bot />}>
          <Field label="LM Studio URL" value={settings.lmStudioBaseUrl} />
          <Field
            label="VRAM Status"
            value={
              activeLoadedModel
                ? `🟢 Active: ${activeLoadedModel.displayName || activeLoadedModel.id} (${activeLoadedModel.quantization || 'Q4'})`
                : '⚪ No model loaded in VRAM'
            }
          />
          <div className="form-field" style={{ margin: '10px 0 0 0' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
              <span>Select Model from Disk ({installedModels.length} installed)</span>
              <button type="button" className="action-link" onClick={fetchInstalledModels} disabled={modelsLoading} style={{ fontSize: '10px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <RefreshCw size={10} className={modelsLoading ? 'spin' : ''} /> Refresh Catalog
              </button>
            </div>
            {installedModels.length > 0 ? (
              <select
                value={localModel}
                onChange={(e) => {
                  const val = e.target.value;
                  setLocalModel(val);
                }}
                disabled={modelActionBusy}
                style={{ width: '100%', maxWidth: '100%', textOverflow: 'ellipsis' }}
              >
                {installedModels.map((m) => {
                  const status = m.state === 'loaded' ? '🟢 [LOADED] ' : '⚪ ';
                  const label = formatGenericModelName(m);
                  return (
                    <option key={m.id} value={m.id} title={m.id}>
                      {status}{label}
                    </option>
                  );
                })}
              </select>
            ) : (
              <input
                type="text"
                value={localModel}
                placeholder="Enter local model ID..."
                onChange={(e) => setLocalModel(e.target.value)}
                onBlur={() => onSave({ lmStudioModel: localModel })}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: '6px',
                  background: 'rgba(0,0,0,.5)',
                  color: 'var(--text)',
                  padding: '7px 9px',
                  fontSize: '11px',
                  width: '100%',
                  maxWidth: '100%',
                  boxSizing: 'border-box',
                }}
              />
            )}
            {localModel && (
              <small style={{ color: 'var(--muted)', fontSize: '10px', marginTop: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block', fontFamily: 'JetBrains Mono, monospace' }} title={localModel}>
                Target: {localModel}
              </small>
            )}
          </div>

          <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
            <button
              type="button"
              className="primary compact"
              onClick={handleLoadModel}
              disabled={modelActionBusy || !localModel || activeLoadedModel?.id === localModel}
              style={{ flex: 1 }}
            >
              <Zap size={13} /> {modelActionBusy ? 'Loading into VRAM…' : activeLoadedModel?.id === localModel ? 'Model Active in VRAM' : 'Load / Switch Model'}
            </button>
            <button
              type="button"
              className="secondary compact"
              onClick={handleUnloadModel}
              disabled={modelActionBusy || loadedModelCount === 0}
              title="Unload all models to free 100% GPU VRAM"
            >
              <Square size={12} /> Free VRAM
            </button>
          </div>

          {actionStatus && (
            <div style={{ marginTop: '8px', fontSize: '11px', color: actionStatus.isError ? 'var(--red)' : 'var(--cyan)' }}>
              {actionStatus.text}
            </div>
          )}
        </Card>
        <Card title="Telemetry" icon={<Activity />}>
          <label className="form-field">
            <span>Refresh interval</span>
            <select value={interval} onChange={(event) => setIntervalValue(Number(event.target.value))}>
              <option value={1000}>1 second</option>
              <option value={2000}>2 seconds</option>
              <option value={5000}>5 seconds</option>
              <option value={10000}>10 seconds</option>
            </select>
          </label>
          <button className="primary" onClick={() => onSave({ telemetryInterval: interval, quotaPolicy: policy, lmStudioModel: localModel })}>Save settings</button>
        </Card>
      </div>

      <div style={{ marginTop: '20px' }}>
        <Card title="Legacy quota routing policy (inactive)" icon={<Zap />}>
          <p style={{ color: 'var(--muted)', fontSize: '12px', marginBottom: '14px' }}>
            These saved tiers are retained for compatibility but no longer influence automatic work. Codex capacity is displayed in the dashboard; task role and risk select the reviewer.
          </p>
          <div className="quota-tiers-table">
            {tiers.map((t) => {
              const cfg = policy[t.key];
              return (
                <div key={t.key} className="quota-tier-row">
                  <div className="tier-meta">
                    <span className="tier-name">{t.label}</span>
                    <span className={`tier-badge tier-${t.badge.toLowerCase()}`}>{t.badge}</span>
                    <small>{t.desc}</small>
                  </div>
                  <div className="tier-controls">
                    <div className="tier-field">
                      <label>Antigravity Model</label>
                      <select disabled value={cfg.antigravityModel} onChange={(e) => updateTier(t.key, 'antigravityModel', e.target.value)}>
                        {(availableModels?.antigravity || [
                          { id: 'gemini-3.7-flash-high', name: 'Gemini 3.7 Flash (High)' },
                          { id: 'gemini-3.7-flash-medium', name: 'Gemini 3.7 Flash (Medium)' },
                          { id: 'gemini-3.7-flash-low', name: 'Gemini 3.7 Flash (Low)' },
                          { id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro (High)' },
                          { id: 'gemini-3.1-pro-low', name: 'Gemini 3.1 Pro (Low)' },
                          { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
                        ]).map((m) => (
                          <option key={m.id} value={m.id}>{m.name || m.id}</option>
                        ))}
                      </select>
                    </div>
                    <div className="tier-field">
                      <label>Codex Review Model</label>
                      <select disabled value={cfg.codexModel || 'none'} onChange={(e) => updateTier(t.key, 'codexModel', e.target.value)}>
                        {(availableModels?.codex || [
                          { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' },
                          { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra' },
                          { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna' },
                          { id: 'gpt-5.5', name: 'GPT-5.5' },
                          { id: 'gpt-5.4', name: 'GPT-5.4' },
                          { id: 'gpt-5.4-mini', name: 'GPT-5.4-Mini' },
                        ]).map((m) => (
                          <option key={m.id} value={m.id}>{m.name || m.id}</option>
                        ))}
                        <option value="none">None (Bypass Codex / Gemma Triage)</option>
                      </select>
                    </div>
                    <div className="tier-field">
                      <label>Codex Effort</label>
                      <select
                        value={cfg.codexEffort || 'low'}
                        disabled
                        onChange={(e) => updateTier(t.key, 'codexEffort', e.target.value)}
                      >
                        {(() => {
                          const selectedModel = availableModels?.codex?.find((m) => m.id === cfg.codexModel);
                          const efforts = selectedModel?.supportedEfforts && selectedModel.supportedEfforts.length > 0
                            ? selectedModel.supportedEfforts
                            : [
                                { effort: 'low', description: 'Low' },
                                { effort: 'medium', description: 'Medium' },
                                { effort: 'high', description: 'High' },
                              ];
                          return efforts.map((eff) => (
                            <option key={eff.effort} value={eff.effort}>
                              {eff.effort.charAt(0).toUpperCase() + eff.effort.slice(1)}
                            </option>
                          ));
                        })()}
                      </select>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'flex-end' }}>
            <button className="primary" disabled>Quota routing disabled</button>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: '20px' }}>
        <Card title="CLI Diagnostics" icon={<Terminal />}>
          <div className="service-list">
            {['antigravity', 'codex', 'git', 'nvidia'].map((name) => (
              <div key={name}>
                <StatusDot ok={health[name]?.available !== false} />
                <span>{name}</span>
                <small>{health[name]?.version || (health[name]?.available === false ? 'Unavailable' : 'Ready')}</small>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </section>
  );
}


