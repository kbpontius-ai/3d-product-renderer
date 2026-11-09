import { DEFAULT_MAX_BYTES } from '@pr/svg';

export async function readPreparationFile(file: File): Promise<{ name: string; source: string }> {
  if (file.size > DEFAULT_MAX_BYTES)
    throw new Error('That SVG exceeds the 5 MB limit. Export a simpler file.');
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > DEFAULT_MAX_BYTES)
    throw new Error('That SVG exceeds the 5 MB limit. Export a simpler file.');
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error('This file is not UTF-8 SVG. Export it as UTF-8 from your vector editor.');
  }
  return {
    name:
      file.name
        .replace(/\.svg$/i, '')
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, 200) || 'Artwork',
    source,
  };
}
