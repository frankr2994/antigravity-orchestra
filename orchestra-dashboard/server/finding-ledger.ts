import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

export type FindingDisposition = 'open' | 'resolved' | 'accepted';
export interface FindingLedgerEntry {
  id: string;
  severity: 'blocker' | 'warning' | 'note';
  description: string;
  evidenceRefs: string[];
  originatingSnapshot: string;
  disposition: FindingDisposition;
  dispositionReason?: string;
  updatedAt: string;
}

export interface FindingLedger {
  schemaVersion: 1;
  taskId: string;
  entries: FindingLedgerEntry[];
  reviews: Array<{ snapshotId: string; originalTextArtifact: string; parsed: boolean; parseError?: string; capturedAt: string }>;
}

export interface StructuredReviewFindings {
  findings: Array<Partial<Pick<FindingLedgerEntry, 'id' | 'severity' | 'description' | 'evidenceRefs'>> & { [key: string]: unknown }>;
  parsed: boolean;
  parseError?: string;
}

const sha = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 20);

export function parseStructuredReview(text: string): StructuredReviewFindings {
  const candidates = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(match => match[1]).concat(text.trim());
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const value: unknown = JSON.parse(candidate);
      if (!value || typeof value !== 'object' || !Array.isArray((value as { findings?: unknown }).findings)) continue;
      const findings = (value as { findings: unknown[] }).findings.filter(item => item && typeof item === 'object').map(item => item as StructuredReviewFindings['findings'][number]);
      return { findings, parsed: true };
    } catch { /* try the next representation, then preserve the original review */ }
  }
  return { findings: [], parsed: false, parseError: 'Reviewer output did not contain a valid findings array.' };
}

export function findingStableId(finding: { id?: unknown; severity?: unknown; description?: unknown; evidenceRefs?: unknown }): string {
  if (typeof finding.id === 'string' && /^[A-Za-z0-9._:-]{2,120}$/.test(finding.id)) return finding.id;
  return `finding-${sha(`${String(finding.severity || 'warning')}\0${String(finding.description || '')}\0${JSON.stringify(finding.evidenceRefs || [])}`)}`;
}

function atomicJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: 'utf8' });
  renameSync(temp, path);
}

export function loadFindingLedger(path: string, taskId: string): FindingLedger {
  if (!existsSync(path)) return { schemaVersion: 1, taskId, entries: [], reviews: [] };
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object' || (value as FindingLedger).schemaVersion !== 1 || (value as FindingLedger).taskId !== taskId) throw new Error('Finding ledger identity or schema mismatch.');
  return value as FindingLedger;
}

export function updateFindingLedger(path: string, taskId: string, snapshotId: string, originalTextArtifact: string, reviewText: string, now = new Date().toISOString()): FindingLedger {
  const ledger = loadFindingLedger(path, taskId);
  const parsed = parseStructuredReview(reviewText);
  const byId = new Map(ledger.entries.map(entry => [entry.id, entry]));
  if (parsed.parsed) {
    for (const finding of parsed.findings) {
      const id = findingStableId(finding);
      const severity = finding.severity === 'blocker' || finding.severity === 'warning' || finding.severity === 'note' ? finding.severity : 'warning';
      const description = typeof finding.description === 'string' && finding.description.trim() ? finding.description.trim() : 'Reviewer finding without a description.';
      const evidenceRefs = Array.isArray(finding.evidenceRefs) ? finding.evidenceRefs.filter((ref): ref is string => typeof ref === 'string').slice(0, 32) : [];
      const previous = byId.get(id);
      byId.set(id, { id, severity, description, evidenceRefs, originatingSnapshot: previous?.originatingSnapshot || snapshotId,
        disposition: previous?.disposition === 'resolved' || previous?.disposition === 'accepted' ? previous.disposition : 'open',
        dispositionReason: previous?.dispositionReason, updatedAt: now });
    }
  }
  ledger.entries = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  ledger.reviews.push({ snapshotId, originalTextArtifact, parsed: parsed.parsed, ...(parsed.parseError ? { parseError: parsed.parseError } : {}), capturedAt: now });
  atomicJson(path, ledger);
  return ledger;
}

export function applyReviewerDisposition(path: string, taskId: string, findingId: string, disposition: Exclude<FindingDisposition, 'open'>, reason: string, now = new Date().toISOString()): FindingLedger {
  const ledger = loadFindingLedger(path, taskId);
  const entry = ledger.entries.find(item => item.id === findingId);
  if (!entry) throw new Error('Finding is not present in the ledger.');
  entry.disposition = disposition;
  entry.dispositionReason = reason.slice(0, 2_000);
  entry.updatedAt = now;
  atomicJson(path, ledger);
  return ledger;
}
