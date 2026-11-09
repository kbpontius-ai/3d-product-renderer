import type { ArtworkPreparationRecipe } from '@pr/design-schema';
import type { BBox, Matrix, Segment } from './path.js';

export interface PreparationIssue {
  id: string;
  severity: 'error' | 'review' | 'info';
  code: string;
  message: string;
  objectId?: string;
  subpathId?: string;
}

export interface PreparationClip {
  segments: Segment[];
  matrix: Matrix;
  fillRule: 'nonzero' | 'evenodd';
  sourceShape?: { name: string; attributes: Record<string, string> };
}

export interface PreparationObject {
  id: string;
  label: string;
  groups: string[];
  segments: Segment[];
  subpathIds?: string[];
  sourceShape?: { name: string; attributes: Record<string, string> };
  matrix: Matrix;
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  fillRule: 'nonzero' | 'evenodd';
  linecap: 'butt' | 'round' | 'square';
  linejoin: 'miter' | 'round' | 'bevel';
  miterLimit: number;
  dashArray: number[];
  dashOffset: number;
  hidden: boolean;
  clips: PreparationClip[][];
  bounds: BBox | null;
}

export interface PreparationGroup {
  id: string;
  label: string;
  objectIds: string[];
}

export interface ArtworkAnalysis {
  sourceDigest: string;
  analyzerVersion: string;
  sourceSvg: string;
  viewBox: BBox;
  unitsConfirmed: boolean;
  objects: PreparationObject[];
  groups: PreparationGroup[];
  issues: PreparationIssue[];
}

export interface PreparationPreview {
  svg: string | null;
  sourceSvg: string;
  objects: PreparationObject[];
  issues: PreparationIssue[];
  boundsMm: BBox | null;
  keptBoundsMm: BBox | null;
  repairChanges?: { svg: string; countersBefore: number; countersAfter: number };
  canSave: boolean;
  recipe: ArtworkPreparationRecipe;
}

export class PreparationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreparationError';
  }
}
