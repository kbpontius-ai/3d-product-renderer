export function snapshotFilename(name: string, at: Date): string {
  const stem = name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  const pad = (value: number) => String(value).padStart(2, '0');
  const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}-${String(at.getMilliseconds()).padStart(3, '0')}`;
  return `${stem || 'viewer'}-snapshot-${day}_${time}.png`;
}
