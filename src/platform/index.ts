import * as os from "node:os";
import * as path from "node:path";
import { macos } from "./macos.js";
import { windows } from "./windows.js";
import type { Platform } from "./types.js";

export type { AEInstall, Platform } from "./types.js";

/** Linux and others: no After Effects, but the server still starts (tests, CI). */
const other: Platform = {
  name: "other",
  userDataDir: () => path.join(os.homedir(), ".config"),
  findInstalls: () => [],
  aePids: () => [],
  aeReady: () => false,
  runScriptFile: () => Promise.reject(Object.assign(new Error("Unsupported platform: After Effects runs on Windows and macOS only"), { hint: undefined })),
  launch: () => undefined,
  compose: () => null,
};

/** The implementation for this OS. AE_MCP_PLATFORM=windows|macos|other overrides (tests). */
export function platform(): Platform {
  const forced = process.env.AE_MCP_PLATFORM;
  if (forced === "windows") return windows;
  if (forced === "macos") return macos;
  if (forced === "other") return other; // unit tests: never see the real After Effects
  if (process.platform === "win32") return windows;
  if (process.platform === "darwin") return macos;
  return other;
}
