import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import type {
  EntityCategory,
  ForgeEntity,
  ReferenceImage,
} from './forge-types.js';
import { getForgeAsset } from './forge.js';

export const FORGE_ENTITIES_DIR = join(config.dataDir, 'forge', 'entities');
if (!existsSync(FORGE_ENTITIES_DIR)) {
  mkdirSync(FORGE_ENTITIES_DIR, { recursive: true });
}

export function listForgeEntities(): ForgeEntity[] {
  try {
    if (!existsSync(FORGE_ENTITIES_DIR)) return [];
    const entityFolders = readdirSync(FORGE_ENTITIES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    const entities: ForgeEntity[] = [];
    for (const folder of entityFolders) {
      const metaPath = join(FORGE_ENTITIES_DIR, folder, 'meta.json');
      if (existsSync(metaPath)) {
        try {
          const raw = readFileSync(metaPath, 'utf8');
          entities.push(JSON.parse(raw) as ForgeEntity);
        } catch {
          /* ignore corrupted entity */
        }
      }
    }
    return entities.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  } catch {
    return [];
  }
}

export function getForgeEntity(id: string): ForgeEntity | null {
  const metaPath = join(FORGE_ENTITIES_DIR, id, 'meta.json');
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, 'utf8')) as ForgeEntity;
  } catch {
    return null;
  }
}

export function saveEntityMeta(entity: ForgeEntity): void {
  const entityDir = join(FORGE_ENTITIES_DIR, entity.id);
  if (!existsSync(entityDir)) mkdirSync(entityDir, { recursive: true });
  writeFileSync(join(entityDir, 'meta.json'), JSON.stringify(entity, null, 2));
}

export function createForgeEntity(data: {
  name: string;
  category?: EntityCategory;
  description?: string;
  triggerWord?: string;
  ipAdapterWeight?: number;
}): ForgeEntity {
  const id = `entity_${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();

  const entity: ForgeEntity = {
    id,
    name: data.name.trim(),
    category: data.category || 'character',
    description: data.description?.trim() || '',
    triggerWord: data.triggerWord?.trim() || undefined,
    referenceImages: [],
    ipAdapterWeight: typeof data.ipAdapterWeight === 'number' ? data.ipAdapterWeight : 0.8,
    createdAt: now,
    updatedAt: now,
  };

  saveEntityMeta(entity);
  return entity;
}

export function updateForgeEntity(id: string, patch: Partial<ForgeEntity>): ForgeEntity {
  const entity = getForgeEntity(id);
  if (!entity) throw new Error(`Entity ${id} not found.`);

  const updated: ForgeEntity = {
    ...entity,
    ...patch,
    id: entity.id, // Immutable ID
    updatedAt: new Date().toISOString(),
  };

  saveEntityMeta(updated);
  return updated;
}

export function deleteForgeEntity(id: string): boolean {
  try {
    const entityDir = join(FORGE_ENTITIES_DIR, id);
    if (existsSync(entityDir)) {
      rmSync(entityDir, { recursive: true, force: true });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function addReferenceImageToEntity(
  entityId: string,
  imageBuffer: Buffer,
  label?: string,
  originalFilename = 'reference.png'
): ReferenceImage {
  const entity = getForgeEntity(entityId);
  if (!entity) throw new Error(`Entity ${entityId} not found.`);

  const entityDir = join(FORGE_ENTITIES_DIR, entityId);
  if (!existsSync(entityDir)) mkdirSync(entityDir, { recursive: true });

  const ext = extname(originalFilename) || '.png';
  const imgId = `ref_${randomUUID().slice(0, 8)}`;
  const filename = `${imgId}${ext}`;
  const localPath = join(entityDir, filename);

  writeFileSync(localPath, imageBuffer);

  const refImage: ReferenceImage = {
    id: imgId,
    label: label || 'front',
    imagePath: localPath,
    imageUrl: `/api/forge/entities/${entityId}/${filename}`,
    uploadedAt: new Date().toISOString(),
  };

  entity.referenceImages.push(refImage);
  entity.updatedAt = new Date().toISOString();
  saveEntityMeta(entity);

  return refImage;
}

export function saveAssetVersionAsEntity(
  assetId: string,
  versionId: string,
  entityName: string,
  category: EntityCategory = 'character',
  description = ''
): ForgeEntity {
  const asset = getForgeAsset(assetId);
  if (!asset) throw new Error(`Asset ${assetId} not found.`);

  const version = asset.versions.find((v) => v.versionId === versionId);
  if (!version) throw new Error(`Version ${versionId} not found on asset ${assetId}.`);

  if (!existsSync(version.outputPath)) {
    throw new Error(`Asset output file not found at ${version.outputPath}`);
  }

  const imageBuffer = readFileSync(version.outputPath);
  const entity = createForgeEntity({
    name: entityName,
    category,
    description: description || version.changeDescription || asset.title,
  });

  addReferenceImageToEntity(entity.id, imageBuffer, 'primary', `${entity.id}_primary.png`);

  return getForgeEntity(entity.id) || entity;
}
