import type { ReactElement, ReactNode } from 'react';
import { humanState } from './format';

export function Metric({ icon, label, value, detail, percent, color }: { icon: ReactNode; label: string; value: string; detail: string; percent: number; color: string }) { return <article className="metric-card"><div className={`metric-icon ${color}`}>{icon}</div><div className="metric-label">{label}</div><strong>{value}</strong><div className="meter"><span className={color} style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} /></div><small>{detail}</small></article>; }
export function PageHeader({ eyebrow, title, subtitle, action }: { eyebrow: string; title: string; subtitle: string; action?: ReactNode }) { return <header className="page-header"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{subtitle}</p></div>{action}</header>; }
export function Card({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) { return <article className="card"><header>{icon}<strong>{title}</strong></header>{children}</article>; }
export function NavButton({ active, icon, label, onClick }: { active: boolean; icon: ReactElement; label: string; onClick: () => void }) { return <button className={`nav-button ${active ? 'active' : ''}`} onClick={onClick}>{icon}<span>{label}</span></button>; }
export function Empty({ icon, title, text }: { icon: ReactNode; title: string; text: string }) { return <div className="empty">{icon}<strong>{title}</strong><p>{text}</p></div>; }
export function StatusDot({ ok, status }: { ok?: boolean; status?: 'red' | 'yellow' | 'green' }) {
  const resolved = status ?? (ok ? 'green' : 'red');
  return <span className={`status-dot ${resolved} ${resolved === 'green' ? 'ok' : resolved === 'red' ? 'bad' : ''}`} />;
}
export function StateBadge({ state }: { state: string }) { return <span className={`state-badge state-${state}`}>{humanState(state)}</span>; }
export function Field({ label, value }: { label: string; value: string }) { return <div className="field"><span>{label}</span><strong>{value}</strong></div>; }
