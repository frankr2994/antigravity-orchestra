export function humanState(state: string) { return state.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
export function formatDate(value: string) { return new Date(value).toLocaleString(); }
export function formatDuration(value: number) { const seconds = Math.max(0, Math.round(value / 1000)); if (seconds < 60) return `${seconds}s`; const minutes = Math.floor(seconds / 60); if (minutes < 60) return `${minutes}m ${seconds % 60}s`; return `${Math.floor(minutes / 60)}h ${minutes % 60}m`; }
