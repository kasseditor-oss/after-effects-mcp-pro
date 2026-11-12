import type { ComposeSpec } from "../imaging.js";

export interface AEInstall {
  version: string; // e.g. "2026"
  appDir: string;
  executable: string; // AfterFX.exe on Windows, the .app bundle on macOS
  aerender: string | null;
  /** After Effects (Beta) from Creative Cloud: listed, but releases are preferred */
  beta?: boolean;
}

/** Releases first (newest first), then Beta builds. */
export function sortInstalls(list: AEInstall[]): AEInstall[] {
  return list.sort((a, b) => Number(!!a.beta) - Number(!!b.beta) || b.version.localeCompare(a.version));
}

/** Everything that differs between Windows and macOS. */
export interface Platform {
  name: "windows" | "macos" | "other";
  /** Folder ExtendScript sees as Folder.userData. */
  userDataDir(): string;
  /** Installed After Effects versions, newest first. */
  findInstalls(): AEInstall[];
  /** PIDs of running After Effects processes (empty when closed). */
  aePids(): number[];
  /** True once AE has finished starting and can safely receive a script. */
  aeReady(): boolean;
  /** Ask the running After Effects to execute a .jsx file (direct mode). */
  runScriptFile(file: string, install: AEInstall | undefined): Promise<void>;
  /** Title of a modal dialog After Effects is showing (it blocks scripts), or null. */
  modalDialog(): string | null;
  /** Start After Effects. */
  launch(install: AEInstall): void;
  /** Resize / tile / encode frames into one image. null = not supported here (caller sends frames as they are). */
  compose(spec: ComposeSpec, workDir: string): { width: number; height: number } | null;
}
