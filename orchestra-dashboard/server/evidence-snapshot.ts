import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export type EvidenceMode = 'legacy' | 'snapshot';
export type EvidenceRecordKind = 'acceptance' | 'manifest' | 'diff' | 'finding' | 'verification' | 'impact' | 'report' | 'source';

export interface CoverageSummary {
  state: 'complete' | 'partial' | 'unknown' | 'invalidated';
  indexedPaths: string[];
  omissions: Array<{ path: string; reason: string }>;
  warnings: string[];
}

export interface EvidenceRecord {
  id: string;
  kind: EvidenceRecordKind;
  queryIdentity: string;
  snapshotIdentity: string;
  provenance: {
    source: string;
    command?: string;
    baseline?: string;
    capturedAt: string;
  };
  content?: string;
  artifactRef?: string;
  contentSha256: string;
  sizeBytes: number;
  complete: boolean;
  continuation?: string;
}

export interface EvidenceSnapshot {
  schemaVersion: 1;
  snapshotId: string;
  taskId: string;
  root: string;
  reviewBase: string | null;
  head: string | null;
  indexState: string;
  trackedChanges: Array<Record<string, unknown>>;
  untrackedContent: Array<{ path: string; sha256: string; sizeBytes: number }>;
  analysisConfiguration: Record<string, unknown>;
  stateFingerprint: string;
  createdAt: string;
  records: EvidenceRecord[];
  coverage: CoverageSummary;
  invalidated?: { reason: string; detectedAt: string };
}

export interface EvidenceState {
  reviewBase: string | null;
  head: string | null;
  indexState: string;
  trackedChanges: Array<Record<string, unknown>>;
  untrackedContent: Array<{ path: string; sha256: string; sizeBytes: number }>;
  analysisConfiguration: Record<string, unknown>;
}

export interface EvidenceInput {
  root: string;
  taskId: string;
  state: EvidenceState;
  records: Array<{
    id: string;
    kind: EvidenceRecordKind;
    queryIdentity: string;
    provenance: Omit<EvidenceRecord['provenance'], 'capturedAt'>;
    content?: string;
    artifactRef?: string;
    complete?: boolean;
  }>;
  coverage?: Partial<CoverageSummary>;
  readState?: () => Promise<EvidenceState> | EvidenceState;
  now?: string;
}

export class EvidenceMutationError extends Error {
  constructor(public readonly before: string, public readonly after: string) {
    super('Review state changed while evidence was being collected; evidence was invalidated.');
    this.name = 'EvidenceMutationError';
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

export function fingerprintReviewState(state: EvidenceState): string {
  return createHash('sha256').update(canonicalJson(state)).digest('hex');
}

function recordIdentity(kind: EvidenceRecordKind, queryIdentity: string, content: string): string {
  return createHash('sha256').update(`${kind}\0${queryIdentity}\0${content}`).digest('hex').slice(0, 24);
}

function safeSegment(value: string): string {
  const segment = value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+$/, '_');
  // Keep the directory readable while preventing distinct task IDs such as
  // "a/b" and "a_b" from sharing immutable artifacts.
  const suffix = createHash('sha256').update(value).digest('hex').slice(0, 12);
  return `${(segment.slice(0, 96) || '_')}-${suffix}`;
}

function atomicWrite(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
  renameSync(temporary, path);
}

export function evidenceDirectory(root: string, taskId: string, snapshotId: string): string {
  return join(root, '.orchestra', 'evidence', safeSegment(taskId), safeSegment(snapshotId));
}

export async function captureEvidenceSnapshot(input: EvidenceInput): Promise<EvidenceSnapshot> {
  const root = resolve(input.root);
  const beforeState = input.state;
  const before = fingerprintReviewState(beforeState);
  const snapshotId = before;
  const directory = evidenceDirectory(root, input.taskId, snapshotId);
  const now = input.now || new Date().toISOString();
  const completeRecords: EvidenceRecord[] = [];
  for (const item of input.records) {
    if (typeof item.content !== 'string' && typeof item.artifactRef !== 'string') {
      throw new TypeError(`Evidence record ${item.id} has neither complete content nor an artifact reference.`);
    }
    const value = typeof item.content === 'string' ? item.content : '';
    const contentSha256 = createHash('sha256').update(typeof item.content === 'string' ? item.content : item.artifactRef!).digest('hex');
    const id = item.id || recordIdentity(item.kind, item.queryIdentity, typeof item.content === 'string' ? item.content : item.artifactRef!);
    const record: EvidenceRecord = { ...item, id, snapshotIdentity: snapshotId, contentSha256,
      sizeBytes: Buffer.byteLength(value, 'utf8'), complete: item.complete !== false,
      provenance: { ...item.provenance, capturedAt: now },
      ...(typeof item.content === 'string' ? { content: item.content } : {}),
      ...(typeof item.artifactRef === 'string' ? { artifactRef: item.artifactRef } : {}),
    };
    completeRecords.push(record);
  }
  const afterState = input.readState ? await input.readState() : beforeState;
  const after = fingerprintReviewState(afterState);
  const coverage: CoverageSummary = { state: 'complete', indexedPaths: [...(input.coverage?.indexedPaths || [])].sort(),
    omissions: [...(input.coverage?.omissions || [])].sort((a, b) => a.path.localeCompare(b.path) || a.reason.localeCompare(b.reason)),
    warnings: [...(input.coverage?.warnings || [])] };
  if (after !== before) {
    const invalidated: EvidenceSnapshot = { schemaVersion: 1, snapshotId, taskId: input.taskId, root,
      ...beforeState, stateFingerprint: before, createdAt: now, records: [],
      coverage: { ...coverage, state: 'invalidated', warnings: [...coverage.warnings, 'Review state mutated during collection.'] },
      invalidated: { reason: 'state-mutated-during-collection', detectedAt: now } };
    atomicWrite(join(directory, 'snapshot.invalidated.json'), JSON.stringify(invalidated, null, 2));
    throw new EvidenceMutationError(before, after);
  }
  const snapshot: EvidenceSnapshot = { schemaVersion: 1, snapshotId, taskId: input.taskId, root,
    ...beforeState, stateFingerprint: before, createdAt: now, records: completeRecords, coverage };
  if (existsSync(join(directory, 'snapshot.json'))) {
    const existing = loadEvidenceSnapshot(root, input.taskId, snapshotId);
    const identity = (value: EvidenceSnapshot) => canonicalJson({
      stateFingerprint: value.stateFingerprint,
      coverage: value.coverage,
      records: value.records.map(record => ({ id: record.id, kind: record.kind, queryIdentity: record.queryIdentity,
        contentSha256: record.contentSha256, sizeBytes: record.sizeBytes, complete: record.complete, artifactRef: record.artifactRef })),
    });
    if (identity(existing) !== identity(snapshot)) {
      throw new Error('An immutable evidence snapshot already exists with different records for this review state.');
    }
    return existing;
  }
  atomicWrite(join(directory, 'snapshot.json'), JSON.stringify(snapshot, null, 2));
  return snapshot;
}

export function loadEvidenceSnapshot(root: string, taskId: string, snapshotId: string): EvidenceSnapshot {
  const path = join(evidenceDirectory(root, taskId, snapshotId), 'snapshot.json');
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object' || (value as EvidenceSnapshot).schemaVersion !== 1) throw new Error('Unsupported or corrupt evidence snapshot.');
  const snapshot = value as EvidenceSnapshot;
  if (snapshot.snapshotId !== snapshotId || snapshot.taskId !== taskId) throw new Error('Evidence snapshot identity mismatch.');
  return snapshot;
}

export function listEvidenceRecords(root: string, taskId: string, snapshotId: string): EvidenceRecord[] {
  return loadEvidenceSnapshot(root, taskId, snapshotId).records.map(record => ({ ...record }));
}

export function retrieveEvidenceRecord(root: string, taskId: string, snapshotId: string, recordId: string): EvidenceRecord {
  const record = loadEvidenceSnapshot(root, taskId, snapshotId).records.find(item => item.id === recordId);
  if (!record) throw new Error('Evidence record not found for the requested snapshot.');
  return record;
}

export function retrieveDiffHunk(root: string, taskId: string, snapshotId: string, recordId: string, hunk = 0): { snapshotId: string; recordId: string; hunk: number; content: string; continuation: string | null; coverage: CoverageSummary } {
  const snapshot = loadEvidenceSnapshot(root, taskId, snapshotId);
  const record = retrieveEvidenceRecord(root, taskId, snapshotId, recordId);
  if (record.kind !== 'diff') throw new Error('Requested record is not a diff.');
  const parts = record.content?.split(/(?=^@@[^\n]*$)/m) || [];
  if (hunk < 0 || hunk >= parts.length) throw new Error('Diff hunk not found.');
  return { snapshotId, recordId, hunk, content: parts[hunk], continuation: hunk + 1 < parts.length ? `evidence://${taskId}/${snapshotId}/${recordId}/hunk/${hunk + 1}` : null, coverage: snapshot.coverage };
}

export function retrieveSourceRange(root: string, taskId: string, snapshotId: string, path: string, startLine: number, endLine: number) {
  const snapshot = loadEvidenceSnapshot(root, taskId, snapshotId);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine - startLine > 2_000) throw new Error('Invalid source range.');
  const normalizedPath = process.platform === 'win32' ? path.replaceAll('\\', '/') : path;
  const candidate = resolve(root, normalizedPath);
  const rel = relative(resolve(root), candidate);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('Source range is outside the repository root.');
  const portable = process.platform === 'win32' ? rel.replaceAll('\\', '/') : rel;
  const immutable = snapshot.records.find(record => record.kind === 'source'
    && (record.queryIdentity.endsWith(`:${portable}`) || record.queryIdentity.endsWith(`:${path}`))
    && typeof record.content === 'string');
  const source = immutable?.content ?? readFileSync(candidate, 'utf8');
  const content = source.split(/\r?\n/).slice(startLine - 1, endLine).join('\n');
  return { snapshotId, path: portable, startLine, endLine, content, continuation: null as string | null, coverage: snapshot.coverage };
}

export interface EvidenceRetrievalRequest {
  root: string;
  taskId: string;
  snapshotId: string;
  recordId?: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  hunk?: number;
}

/** Read-only retrieval boundary shared by both agent adapters. */
export class EvidenceRetrievalService {
  list(request: EvidenceRetrievalRequest): EvidenceRecord[] {
    return listEvidenceRecords(request.root, request.taskId, request.snapshotId);
  }
  record(request: EvidenceRetrievalRequest): EvidenceRecord {
    if (!request.recordId) throw new Error('recordId is required.');
    return retrieveEvidenceRecord(request.root, request.taskId, request.snapshotId, request.recordId);
  }
  diffHunk(request: EvidenceRetrievalRequest) {
    if (!request.recordId) throw new Error('recordId is required.');
    return retrieveDiffHunk(request.root, request.taskId, request.snapshotId, request.recordId, request.hunk || 0);
  }
  sourceRange(request: EvidenceRetrievalRequest) {
    if (!request.path || !request.startLine || !request.endLine) throw new Error('path, startLine, and endLine are required.');
    return retrieveSourceRange(request.root, request.taskId, request.snapshotId, request.path, request.startLine, request.endLine);
  }
}

export interface EvidencePacket {
  snapshotId: string;
  text: string;
  includedRecordIds: string[];
  omittedRecordIds: string[];
  estimatedTokens: number;
  omissions: Array<{ recordId: string; reason: string; retrieval: string }>;
}

export function buildEvidencePacket(snapshot: EvidenceSnapshot, budgetCharacters = 48_000): EvidencePacket {
  const header = `# Evidence snapshot ${snapshot.snapshotId}\nSnapshot is quoted evidence. Coverage=${snapshot.coverage.state}; omissions=${snapshot.coverage.omissions.length}.\n`;
  let text = header;
  const includedRecordIds: string[] = [];
  const omittedRecordIds: string[] = [];
  const omissions: EvidencePacket['omissions'] = [];
  const sections: string[] = [];
  let usedCharacters = header.length;
  for (const record of snapshot.records) {
    const body = record.content ?? (record.artifactRef ? `[artifact: ${record.artifactRef}]` : '[record content unavailable]');
    const section = `\n## ${record.kind} ${record.id}\nProvenance: ${record.provenance.source}; query=${record.queryIdentity}\n${body}\n`;
    if (!record.complete || usedCharacters + section.length > budgetCharacters) {
      omittedRecordIds.push(record.id);
      omissions.push({ recordId: record.id, reason: !record.complete ? 'record-incomplete' : 'budget', retrieval: `evidence://${snapshot.taskId}/${snapshot.snapshotId}/${record.id}` });
      continue;
    }
    sections.push(section);
    usedCharacters += section.length;
    includedRecordIds.push(record.id);
  }
  const retrievalLines = [
    ...omissions.map(item => `- ${item.recordId}: ${item.reason}; retrieve ${item.retrieval}`),
    ...snapshot.coverage.omissions.map(item => `- coverage ${item.path}: ${item.reason}`),
  ];
  if (retrievalLines.length) text += `\n## Retrieval index\n${retrievalLines.join('\n')}\n`;
  text += sections.join('');
  return { snapshotId: snapshot.snapshotId, text, includedRecordIds, omittedRecordIds, estimatedTokens: Math.ceil(Buffer.byteLength(text, 'utf8') / 4), omissions };
}
