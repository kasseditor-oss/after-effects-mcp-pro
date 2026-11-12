/**
 * After Effects version compatibility.
 *
 * The version comes from the listener heartbeat (listener mode) or from the last
 * bridge_status / get_project_info answer (direct mode). AE_MCP_ASSUME_AE_VERSION
 * overrides it (tests, or forcing the legacy paths).
 *
 * Features that need a newer AE either take an older API automatically (an extra
 * argument tells the runtime which path to use) or fail with a clear message
 * before anything reaches After Effects, never with an ExtendScript error.
 */

/** Oldest After Effects this server is tested against (AE 2022). */
export const MIN_AE = 22.0;

let reported: string | null = null;

/** Remember the version AE reported (app.version, e.g. "26.5x89"). */
export function noteAEVersion(v: unknown): void {
  if (typeof v === "string" && /^\d+\.\d+/.test(v)) reported = v;
}

/** "26.5x89" -> 26.5, "22.6.0" -> 22.6; null when unknown. */
export function parseAEVersion(v: string | null | undefined): number | null {
  const m = /^(\d+)\.(\d+)/.exec(v ?? "");
  return m ? Number(m[1]) + Number(m[2]) / 10 : null;
}

/** Best known AE version: env override, then the heartbeat, then the last reported one. */
export function currentAEVersion(heartbeatAE?: string | null): string | null {
  const forced = process.env.AE_MCP_ASSUME_AE_VERSION;
  if (forced) return forced;
  // remembered: a heartbeat read while the listener rewrites it can come back empty
  if (heartbeatAE && /^\d+\.\d+/.test(heartbeatAE)) reported = heartbeatAE;
  return reported;
}

/** Marketing year for a major version: 22 -> 2022, 26 -> 2026. */
export const aeYear = (v: number) => 2000 + Math.floor(v);

interface Gate {
  tool: string;
  min: number;
  feature: string;
  /** only when these arguments use the feature */
  when?: (a: any) => boolean;
  hint: string;
}

const usesCaps = (a: any) => (a.caps !== undefined && a.caps !== "normal") || (a.style?.caps !== undefined && a.style.caps !== "normal");

/** Features with no older alternative: refused with a clear error below `min`. */
export const GATES: Gate[] = [
  { tool: "list_fonts", min: 24.0, feature: "listing installed fonts (app.fonts)", hint: "Pass the font's PostScript name (e.g. ArialMT) directly to create_text_layer / set_text." },
  { tool: "create_text_layer", min: 24.0, feature: "small caps / all caps (fontCapsOption)", when: usesCaps, hint: "Type the text in capitals instead." },
  { tool: "set_text", min: 24.0, feature: "small caps / all caps (fontCapsOption)", when: usesCaps, hint: "Type the text in capitals instead." },
  { tool: "set_essential_properties", min: 16.1, feature: "Essential Graphics from scripts", hint: "Add the properties in the Essential Graphics panel by hand." },
  { tool: "instantiate_template", min: 17.0, feature: "Essential Properties overrides", hint: "Duplicate the comp and edit it directly." },
  { tool: "export_mogrt", min: 16.1, feature: "exporting Motion Graphics templates from scripts", hint: "Export from the Essential Graphics panel by hand." },
];

/** Documented in README > Compatibility (keep both in sync). */
export const FALLBACKS = [
  { feature: "set_track_matte with any matte layer (setTrackMatte)", min: 23.0, older: "the matte layer is moved directly above and trackMatteType is used" },
  { feature: "shape gradient colors", min: 22.0, older: "always a Gradient Ramp effect (no scripting API for gradient stops)" },
];

export interface CompatResult {
  error?: string;
  hint?: string;
  /** extra arguments for the runtime (older API paths) */
  extra?: Record<string, unknown>;
}

/** Check one call against the AE version. Unknown version: everything is allowed. */
export function checkCompat(tool: string, args: any, aeVersion: string | null): CompatResult {
  const v = parseAEVersion(aeVersion);
  if (v === null) return {};
  for (const g of GATES) {
    if (g.tool !== tool || v >= g.min || (g.when && !g.when(args ?? {}))) continue;
    return {
      error: `${tool}: ${g.feature} needs After Effects ${aeYear(g.min)} (${g.min.toFixed(1)}) or newer; this is After Effects ${aeVersion}`,
      hint: g.hint,
    };
  }
  if (tool === "set_track_matte" && v < 23.0) return { extra: { legacyMatte: true } };
  return {};
}

/** Warning when AE is older than the oldest tested version. */
export function versionWarning(aeVersion: string | null): string | null {
  const v = parseAEVersion(aeVersion);
  if (v === null || v >= MIN_AE) return null;
  return `After Effects ${aeVersion} is older than the oldest tested version (${aeYear(MIN_AE)}, ${MIN_AE.toFixed(1)}); some tools may fail.`;
}
