export function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

export function toSnakeCase(str: string): string {
  return str
    .replace(/\s+/g, '_')
    .toLowerCase();
}