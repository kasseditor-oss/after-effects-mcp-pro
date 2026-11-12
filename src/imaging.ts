import { platform } from "./platform/index.js";

export type ImageFormat = "png" | "jpeg";

export interface ComposeSpec {
  files: string[];
  labels?: string[];
  /** Longest side of each cell (or of the single image). */
  maxSize: number;
  /** Columns of the grid; 1 file with columns 1 = plain resize/convert. */
  columns: number;
  format: ImageFormat;
  quality: number;
  output: string;
  /** What shows through transparent pixels: the comp color, a checkerboard, or nothing (PNG alpha). */
  background?: { type: "color"; rgb: number[] } | { type: "checker" } | { type: "none" };
}

/**
 * Resize / convert / tile frames into one image with the platform's image tools.
 * Returns its size, or null when this platform cannot (the caller then sends the
 * original frames separately).
 */
export function compose(spec: ComposeSpec, workDir: string): { width: number; height: number } | null {
  return platform().compose(spec, workDir);
}
