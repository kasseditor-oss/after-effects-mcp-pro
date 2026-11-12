// Thin facade over src/platform/ (kept so scripts/install-ae.mjs and older imports work).
import * as path from "node:path";
import { platform } from "./platform/index.js";

export type { AEInstall } from "./platform/index.js";

export const isWin = process.platform === "win32";
export const isMac = process.platform === "darwin";

/** Same folder ExtendScript sees as `Folder.userData + "/ae-mcp-pro"`. */
export function bridgeDir(): string {
  if (process.env.AE_MCP_BRIDGE_DIR) return process.env.AE_MCP_BRIDGE_DIR;
  return path.join(platform().userDataDir(), "ae-mcp-pro");
}

export const findInstalls = () => platform().findInstalls();
export const aePids = () => platform().aePids();
export const isAERunning = () => platform().aePids().length > 0;
export const aeReady = () => platform().aeReady();
