export function formatGenericModelName(model: { id: string; displayName?: string; quantization?: string }): string {
  if (model.displayName) return `${model.displayName}${model.quantization ? ` · ${model.quantization}` : ''}`;
  let clean = model.id.includes('/') ? model.id.split('/').pop()! : model.id;
  if (clean.includes('@')) clean = clean.split('@')[0];
  clean = clean.replace(/[-_]+/g, ' ').trim();
  clean = clean.split(' ').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  return `${clean}${model.quantization ? ` · ${model.quantization}` : ''}`;
}
