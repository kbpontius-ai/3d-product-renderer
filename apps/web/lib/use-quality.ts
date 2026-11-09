'use client';

import { useEffect, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { MIN_SAMPLES, QUALITY_LEVELS, nextLevel, type QualityLevel } from './quality';

/**
 * Watches how the preview is actually performing and moves the quality level to match (F-PREV-03).
 *
 * Measuring frame *times*, not a frame rate. The viewport renders on demand — it draws when
 * something changes and sits still otherwise — so frames per second is mostly a measure of how
 * recently the customer moved the mouse. What matters is how long a frame takes when one is asked
 * for, which is exactly what a drag feels like.
 *
 * Only consecutive frames count. A gap longer than `IDLE_GAP_MS` means the viewport was idle and
 * the "frame" spans the pause rather than the work, so it is dropped rather than counted as a
 * catastrophic one.
 */

/** Longer than this between frames and the viewport was resting, not struggling. */
const IDLE_GAP_MS = 250;

/** How many consecutive frames to hold. Two seconds of dragging at a sensible rate. */
const WINDOW = 60;

/** How long to leave a new level alone before judging it. */
const SETTLE_MS = 1500;

export function useAdaptiveQuality(startIndex: number): QualityLevel {
  const { setDpr } = useThree();
  const [index, setIndex] = useState(startIndex);

  const samples = useRef<number[]>([]);
  const lastFrame = useRef(0);
  const changedAt = useRef(0);

  const level = QUALITY_LEVELS[index] ?? QUALITY_LEVELS[1]!;

  useEffect(() => {
    setDpr(level.dpr);
  }, [level.dpr, setDpr]);

  useFrame(() => {
    const now = performance.now();
    const elapsed = now - lastFrame.current;
    lastFrame.current = now;

    if (elapsed > IDLE_GAP_MS) return;
    samples.current.push(elapsed);
    if (samples.current.length > WINDOW) samples.current.shift();

    // Let a new level bed in before measuring it: the frame that changes the resolution is itself
    // expensive, and judging the new level by it would step straight down again.
    if (samples.current.length < MIN_SAMPLES || now - changedAt.current < SETTLE_MS) return;

    const wanted = nextLevel(index, samples.current);
    if (wanted === index) return;

    samples.current = [];
    changedAt.current = now;
    setIndex(wanted);
  });

  return level;
}
