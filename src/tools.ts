import { z } from "zod";

/** Reference to a composition: its name, or its numeric project item id. Omit to use the active comp. */
export const Comp = z
  .union([z.string(), z.number().int()])
  .optional()
  .describe("Composition name or numeric item id. Omit to use the active composition.");
/** Reference to a layer: 1-based index, name, or "id:<layerId>". */
export const Layer = z
  .union([z.number().int().positive(), z.string()])
  .describe("Layer: 1-based index, exact name, or 'id:<layerId>' (stable across reordering).");
const LayerOpt = Layer.optional().describe("Layer: 1-based index, name or 'id:<id>'. Omit to use the single selected layer.");
const Layers = z.array(Layer).describe("List of layers (index, name or 'id:<id>').");
const Color = z
  .union([z.string(), z.array(z.number()).min(3).max(4)])
  .describe("Color as '#RRGGBB' or [r,g,b] (0-1 or 0-255).");
const Vec = z.array(z.number()).min(1).max(3);
const Time = z.number().describe("Time in seconds (comp time).");
const Easing = z
  .enum(["linear", "hold", "easy-ease", "ease-in", "ease-out", "ease-in-out", "smooth", "strong-ease", "expo", "snap", "anticipate"])
  .describe("Keyframe easing preset.");
const AnyValue = z.any().describe("Value: number, array ([x,y] / [x,y,z]), color, string (Source Text) or object (shape path / text style).");

const Keyframe = z.object({
  time: Time,
  value: AnyValue,
  easing: Easing.optional(),
  easeIn: z.object({ speed: z.number().optional(), influence: z.number().min(0.1).max(100).optional() }).optional().describe("Custom incoming ease."),
  easeOut: z.object({ speed: z.number().optional(), influence: z.number().min(0.1).max(100).optional() }).optional().describe("Custom outgoing ease."),
  roving: z.boolean().optional(),
});

const Transform = {
  name: z.string().optional().describe("Layer name."),
  position: Vec.optional().describe("[x,y] or [x,y,z] in comp pixels. Default: comp center."),
  anchorPoint: Vec.optional(),
  scale: z.union([z.number(), Vec]).optional().describe("Percent. A number scales uniformly."),
  rotation: z.number().optional().describe("Degrees."),
  opacity: z.number().min(0).max(100).optional(),
  startTime: z.number().optional(),
  inPoint: z.number().optional(),
  outPoint: z.number().optional(),
  duration: z.number().positive().optional().describe("Layer duration in seconds from its in point."),
  threeD: z.boolean().optional(),
  blendMode: z.string().optional().describe("normal, multiply, screen, add, overlay, soft light, ... "),
  label: z.number().int().min(0).max(16).optional(),
  parent: z.union([z.number(), z.string()]).optional().describe("Parent layer, or '' for none."),
};

const ShapeSpec = z.object({
  type: z.enum(["rectangle", "ellipse", "polygon", "star", "path"]).default("rectangle"),
  name: z.string().optional(),
  size: z.union([z.number(), z.array(z.number()).length(2)]).optional().describe("[w,h] or a single number. Default 200."),
  roundness: z.number().optional(),
  points: z.number().int().optional().describe("Polygon/star points."),
  outerRadius: z.number().optional(),
  innerRadius: z.number().optional(),
  vertices: z.array(z.array(z.number()).length(2)).optional().describe("For type 'path': [[x,y],...] relative to the layer."),
  inTangents: z.array(z.array(z.number()).length(2)).optional(),
  outTangents: z.array(z.array(z.number()).length(2)).optional(),
  closed: z.boolean().optional(),
  fill: z.union([Color, z.literal(false)]).optional().describe("Fill color, or false for no fill. Default white."),
  fillOpacity: z.number().optional(),
  stroke: Color.optional(),
  strokeWidth: z.number().optional(),
  strokeOpacity: z.number().optional(),
  lineCap: z.enum(["butt", "round", "projecting"]).optional(),
  gradient: z.object({ type: z.enum(["linear", "radial"]).optional(), start: z.array(z.number()).optional(), end: z.array(z.number()).optional() }).optional(),
  trimPaths: z.object({ start: z.number().optional(), end: z.number().optional(), offset: z.number().optional() }).optional().describe("Adds Trim Paths (great for line/stroke reveal animations)."),
  repeater: z.object({ copies: z.number().optional(), offsetPosition: z.array(z.number()).optional(), offsetRotation: z.number().optional() }).optional(),
  offset: z.array(z.number()).optional().describe("Position of this shape group inside the layer."),
  rotation: z.number().optional(),
});

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  shape: z.ZodRawShape;
  /** Runtime handler name (defaults to tool name). `null` = implemented in Node. */
  handler?: string | null;
  readOnly?: boolean;
  destructive?: boolean;
  timeoutMs?: number;
  undo?: boolean;
  category: string;
}

const t = (d: ToolDef) => d;

export const TOOLS: ToolDef[] = [
  // ------------------------------------------------------------- session
  t({ category: "session", name: "bridge_status", handler: null, readOnly: true, title: "Bridge status", description: "Check the connection to After Effects: install found, AE running, bridge mode (listener/direct), AE version, open project. Call this first if anything fails.", shape: {} }),
  t({ category: "session", name: "launch_after_effects", handler: null, title: "Launch After Effects", description: "Start After Effects if it is not running and wait until it accepts commands (can take 30-120s).", shape: { waitSeconds: z.number().int().min(10).max(600).optional() } }),

  // ------------------------------------------------------------- project
  t({ category: "project", name: "get_project_info", readOnly: true, title: "Project info", description: "Project overview: file path, unsaved changes, item counts, compositions, active comp, bit depth, render queue size.", shape: {} }),
  t({ category: "project", name: "list_project_items", readOnly: true, title: "List project items", description: "List project panel items (compositions, footage, solids, folders) with ids, folders, sizes, missing-footage flags. Paginated: limit (default 200, max 1000) and offset; the response has total and truncated.", shape: { limit: z.number().int().min(1).max(1000).optional(), offset: z.number().int().min(0).optional(), type: z.enum(["composition", "footage", "folder", "solid", "video", "still", "audio"]).optional(), folder: z.string().optional(), query: z.string().optional().describe("Case-insensitive name filter.") } }),
  t({ category: "project", name: "save_project", title: "Save project", description: "Save the project, or 'Save As' when path is given.", shape: { path: z.string().optional().describe("Absolute .aep path for Save As."), overwrite: z.boolean().optional() } }),
  t({ category: "project", name: "open_project", destructive: true, undo: false, title: "Open project", description: "Open an .aep file. Refuses if the current project has unsaved changes unless discardChanges is true.", shape: { path: z.string(), discardChanges: z.boolean().optional() } }),
  t({ category: "project", name: "new_project", destructive: true, undo: false, title: "New project", description: "Close the current project and create an empty one. Refuses on unsaved changes unless discardChanges is true.", shape: { discardChanges: z.boolean().optional() } }),
  t({ category: "project", name: "import_files", title: "Import files", description: "Import footage/images/audio/PSD/AI files (optionally as image sequence) into the project, into a folder, and optionally straight into a comp.", shape: { paths: z.array(z.string()).min(1), folder: z.string().optional().describe("Project folder (created if missing)."), sequence: z.boolean().optional(), forceAlphabetical: z.boolean().optional(), importAs: z.enum(["footage", "composition", "comp_cropped_layers", "project"]).optional(), addToComp: z.union([z.string(), z.number()]).optional(), startTime: z.number().optional() } }),
  t({ category: "project", name: "create_folder", title: "Create folder", description: "Create a folder in the project panel.", shape: { name: z.string(), parent: z.string().optional() } }),
  t({ category: "project", name: "organize_items", title: "Move items to folder", description: "Move project items into a folder (created if missing).", shape: { items: z.array(z.union([z.string(), z.number()])).min(1), folder: z.string(), createFolder: z.boolean().optional() } }),
  t({ category: "project", name: "modify_item", title: "Modify project item", description: "Rename, relabel, comment, replace footage source, conform frame rate, set loop count, or delete a project item.", shape: { item: z.union([z.string(), z.number()]), name: z.string().optional(), label: z.number().int().min(0).max(16).optional(), comment: z.string().optional(), replaceWithFile: z.string().optional(), frameRate: z.number().optional(), loop: z.number().int().optional(), delete: z.boolean().optional() } }),

  // ------------------------------------------------------------- compositions
  t({ category: "composition", name: "list_compositions", readOnly: true, title: "List compositions", description: "All compositions with id, size, duration, fps, layer count, work area.", shape: {} }),
  t({ category: "composition", name: "get_composition", readOnly: true, title: "Composition details", description: "Full composition details: settings, markers, selection and a summary of each layer (type, timing, transform, effects, parent, matte). At most layerLimit (default 200) layers; use list_layers to page through more.", shape: { comp: Comp, layerLimit: z.number().int().min(0).max(1000).optional() } }),
  t({ category: "composition", name: "create_composition", title: "Create composition", description: "Create a composition. Use preset for common sizes (1080p, 4k, vertical/reels/tiktok, square, portrait-4x5...). Opens it in the viewer.", shape: { name: z.string(), preset: z.enum(["hd", "1080p", "720p", "4k", "uhd", "2k", "vertical", "story", "reels", "tiktok", "shorts", "square", "instagram", "portrait-4x5", "youtube-thumbnail", "twitter"]).optional(), width: z.number().int().min(4).max(30000).optional(), height: z.number().int().min(4).max(30000).optional(), duration: z.number().positive().optional().describe("Seconds, default 10."), frameRate: z.number().positive().max(999).optional().describe("Default 30."), pixelAspect: z.number().positive().optional(), backgroundColor: Color.optional(), folder: z.string().optional(), open: z.boolean().optional() } }),
  t({ category: "composition", name: "set_composition_settings", title: "Composition settings", description: "Change composition name, size, duration, fps, background, work area, motion blur, shutter, renderer, current time, resolution.", shape: { comp: Comp, name: z.string().optional(), width: z.number().int().optional(), height: z.number().int().optional(), duration: z.number().positive().optional(), frameRate: z.number().positive().optional(), pixelAspect: z.number().optional(), backgroundColor: Color.optional(), workAreaStart: z.number().optional(), workAreaDuration: z.number().optional(), motionBlur: z.boolean().optional(), shutterAngle: z.number().optional(), shutterPhase: z.number().optional(), currentTime: z.number().optional(), renderer: z.string().optional(), hideShyLayers: z.boolean().optional(), resolutionFactor: z.array(z.number().int()).length(2).optional(), open: z.boolean().optional() } }),
  t({ category: "composition", name: "duplicate_composition", title: "Duplicate composition", description: "Duplicate a composition.", shape: { comp: Comp, newName: z.string().optional() } }),
  t({ category: "composition", name: "open_composition", title: "Open composition", description: "Open a composition in the viewer/timeline and optionally move the playhead.", shape: { comp: Comp, time: z.number().optional() } }),
  t({ category: "composition", name: "precompose_layers", title: "Pre-compose", description: "Pre-compose layers into a new composition.", shape: { comp: Comp, layers: Layers, name: z.string().optional(), moveAllAttributes: z.boolean().optional() } }),

  // ------------------------------------------------------------- layer creation
  t({ category: "layers", name: "create_text_layer", title: "Create text layer", description: "Create a text layer with full styling (font, size, color, stroke, tracking, leading, alignment, caps). Anchor is centered on the text. Returns the font AE actually used.", shape: { comp: Comp, text: z.string(), font: z.string().optional().describe("PostScript name, e.g. 'Arial-BoldMT' (see list_fonts)."), fontSize: z.number().optional(), color: Color.optional(), strokeColor: Color.optional(), strokeWidth: z.number().optional(), tracking: z.number().optional(), leading: z.number().optional(), justification: z.enum(["left", "center", "right", "justify"]).optional(), allCaps: z.boolean().optional(), fauxBold: z.boolean().optional(), fauxItalic: z.boolean().optional(), boxSize: z.array(z.number()).length(2).optional().describe("Paragraph text box [w,h]."), centerAnchor: z.boolean().optional(), ...Transform } }),
  t({ category: "layers", name: "create_shape_layer", title: "Create shape layer", description: "Create a shape layer with one or many shapes (rectangle, ellipse, polygon, star, custom path), fill/stroke, rounded corners, Trim Paths and Repeater.", shape: { comp: Comp, shapes: z.array(ShapeSpec).optional().describe("Several shapes in one layer. If omitted, the top-level shape fields are used."), ...ShapeSpec.partial().shape, ...Transform } }),
  t({ category: "layers", name: "create_solid_layer", title: "Create solid / adjustment layer", description: "Create a solid color layer, or an adjustment layer (adjustment: true).", shape: { comp: Comp, color: Color.optional(), width: z.number().int().optional(), height: z.number().int().optional(), adjustment: z.boolean().optional(), ...Transform } }),
  t({ category: "layers", name: "create_null_layer", title: "Create null", description: "Create a null object, optionally parenting layers to it.", shape: { comp: Comp, childLayers: Layers.optional(), ...Transform } }),
  t({ category: "layers", name: "create_camera", title: "Create camera", description: "Create a 3D camera (two-node). Set zoom or focal length (mm), depth of field, focus distance, aperture.", shape: { comp: Comp, name: z.string().optional(), position: z.array(z.number()).length(3).optional(), pointOfInterest: z.array(z.number()).length(3).optional(), zoom: z.number().optional(), focalLength: z.number().optional(), depthOfField: z.boolean().optional(), focusDistance: z.number().optional(), aperture: z.number().optional(), blurLevel: z.number().optional() } }),
  t({ category: "layers", name: "create_light", title: "Create light", description: "Create a light (point, spot, parallel, ambient) with color, intensity, cone and shadows.", shape: { comp: Comp, name: z.string().optional(), lightType: z.enum(["point", "spot", "parallel", "ambient"]).optional(), color: Color.optional(), intensity: z.number().optional(), coneAngle: z.number().optional(), coneFeather: z.number().optional(), castsShadows: z.boolean().optional(), position: z.array(z.number()).length(3).optional(), pointOfInterest: z.array(z.number()).length(3).optional() } }),
  t({ category: "layers", name: "add_item_to_comp", title: "Add footage/comp to comp", description: "Add a project item (footage, image, audio, or another comp) as a layer. fitToComp scales it to fit or fill the frame.", shape: { comp: Comp, item: z.union([z.string(), z.number()]).describe("Item name or id."), fitToComp: z.enum(["fit", "fill"]).optional(), ...Transform } }),

  // ------------------------------------------------------------- layer editing
  t({ category: "layers", name: "list_layers", readOnly: true, title: "List layers", description: "List layers of a comp with type, timing, transform, parent, matte and effects (text cut to 200 chars). Paginated: limit (default 200, max 1000) and offset; the response has total and truncated.", shape: { comp: Comp, limit: z.number().int().min(1).max(1000).optional(), offset: z.number().int().min(0).optional(), type: z.enum(["text", "shape", "solid", "adjustment", "null", "camera", "light", "precomp", "image", "video", "audio"]).optional(), query: z.string().optional() } }),
  t({ category: "layers", name: "get_layer_details", readOnly: true, title: "Layer details", description: "Deep inspection of a layer: modified/animated property tree with keyframes and expressions, markers, bounding box.", shape: { comp: Comp, layer: Layer, depth: z.number().int().min(1).max(8).optional(), includeKeyframes: z.boolean().optional(), onlyAnimated: z.boolean().optional() } }),
  t({ category: "layers", name: "set_layer_properties", title: "Set layer properties", description: "Change transform, timing, switches (enabled, solo, shy, lock, 3D, motion blur, adjustment, collapse), blend mode, quality, parent, label or name on one or many layers.", shape: { comp: Comp, layer: LayerOpt, layers: Layers.optional().describe("Apply the same change to several layers."), newName: z.string().optional(), enabled: z.boolean().optional(), locked: z.boolean().optional(), shy: z.boolean().optional(), solo: z.boolean().optional(), motionBlur: z.boolean().optional(), adjustmentLayer: z.boolean().optional(), collapseTransformation: z.boolean().optional(), quality: z.enum(["best", "draft", "wireframe"]).optional(), audioEnabled: z.boolean().optional(), timeRemapEnabled: z.boolean().optional(), stretch: z.number().optional().describe("Time stretch percent."), autoOrient: z.boolean().optional(), centerAnchor: z.boolean().optional(), ...Transform } }),
  t({ category: "layers", name: "duplicate_layer", title: "Duplicate layer", description: "Duplicate a layer one or more times, optionally offsetting position and time for each copy.", shape: { comp: Comp, layer: Layer, count: z.number().int().min(1).max(200).optional(), newName: z.string().optional(), offset: z.array(z.number()).length(2).optional(), timeOffset: z.number().optional() } }),
  t({ category: "layers", name: "delete_layers", destructive: true, title: "Delete layers", description: "Delete one or more layers.", shape: { comp: Comp, layers: Layers } }),
  t({ category: "layers", name: "reorder_layer", title: "Reorder layer", description: "Move a layer to top/bottom, to an index, or before/after another layer.", shape: { comp: Comp, layer: Layer, position: z.enum(["top", "bottom", "before", "after", "index"]), relativeTo: Layer.optional(), index: z.number().int().optional() } }),
  t({ category: "layers", name: "set_parent", title: "Parent layers", description: "Parent layers to another layer (or unparent with parent: null).", shape: { comp: Comp, layers: Layers, parent: z.union([z.number(), z.string(), z.null()]) } }),
  t({ category: "layers", name: "set_track_matte", title: "Track matte", description: "Use another layer as alpha/luma (inverted) matte. Uses the AE 2023+ API so any layer can be the matte.", shape: { comp: Comp, layer: Layer, matteLayer: Layer.optional().describe("Default: the layer above."), type: z.enum(["alpha", "alpha-inverted", "luma", "luma-inverted", "none"]).optional() } }),
  t({ category: "layers", name: "split_layer", title: "Split layer", description: "Split a layer at a time (default: playhead).", shape: { comp: Comp, layer: Layer, time: z.number().optional() } }),
  t({ category: "layers", name: "sequence_layers", title: "Sequence layers", description: "Place layers one after another (with optional overlap) or stagger their start times.", shape: { comp: Comp, layers: Layers, startTime: z.number().optional(), overlap: z.number().optional(), stagger: z.number().optional().describe("Seconds between starts (instead of end-to-end)."), order: z.enum(["given", "reverse"]).optional() } }),
  t({ category: "layers", name: "align_layers", title: "Align layers", description: "Align layers to the composition (left/center/right, top/center/bottom) using their real visual bounds, with an optional margin.", shape: { comp: Comp, layers: Layers, horizontal: z.enum(["none", "left", "center", "right"]).optional(), vertical: z.enum(["none", "top", "center", "bottom"]).optional(), margin: z.number().optional() } }),
  t({ category: "layers", name: "set_text", title: "Edit text", description: "Change the text and/or style of a text layer (font, size, color, stroke, tracking, leading, justification).", shape: { comp: Comp, layer: Layer, text: z.string().optional(), font: z.string().optional(), fontSize: z.number().optional(), fillColor: Color.optional(), strokeColor: Color.optional(), strokeWidth: z.number().optional(), tracking: z.number().optional(), leading: z.number().optional(), justification: z.enum(["left", "center", "right", "justify"]).optional(), allCaps: z.boolean().optional(), fauxBold: z.boolean().optional(), fauxItalic: z.boolean().optional(), baselineShift: z.number().optional(), time: z.number().optional().describe("Set as a Source Text keyframe at this time.") } }),

  // ------------------------------------------------------------- properties / animation
  t({ category: "animation", name: "get_property", readOnly: true, title: "Read property", description: "Read any property by path, e.g. 'Position', 'Transform/Opacity', 'Effects/Gaussian Blur/Blurriness', 'Contents/Rectangle 1/Fill 1/Color', or match names. Returns value, keyframes, expression; for groups, lists children.", shape: { comp: Comp, layer: Layer, property: z.string(), time: z.number().optional() } }),
  t({ category: "animation", name: "set_property", title: "Set property", description: "Set any property's value by path. If the property is animated, sets a keyframe at 'time' (or the playhead).", shape: { comp: Comp, layer: Layer, property: z.string(), value: AnyValue, time: z.number().optional() } }),
  t({ category: "animation", name: "set_keyframes", title: "Set keyframes", description: "Add many keyframes to any property in one call, with easing presets or custom ease per key. Use replace:true to clear existing keys first.", shape: { comp: Comp, layer: Layer, property: z.string(), keyframes: z.array(Keyframe).min(1), easing: Easing.optional().describe("Default easing for all keys."), replace: z.boolean().optional(), separateDimensions: z.boolean().optional() } }),
  t({ category: "animation", name: "remove_keyframes", destructive: true, title: "Remove keyframes", description: "Remove keyframes from a property (all, or within a from/to time range).", shape: { comp: Comp, layer: Layer, property: z.string(), from: z.number().optional(), to: z.number().optional() } }),
  t({ category: "animation", name: "set_expression", title: "Set expression", description: "Set or clear (empty string) an expression on any property. Returns the expression error right away if AE reports one.", shape: { comp: Comp, layer: Layer, property: z.string(), expression: z.string(), enabled: z.boolean().optional() } }),
  t({ category: "animation", name: "check_expressions", readOnly: true, title: "Check expressions", description: "Find every expression in a comp and report the ones that error.", shape: { comp: Comp } }),
  t({ category: "animation", name: "animate_layer", title: "Animation preset", description: "One-call motion design presets: fade-in/out, slide-in/out (direction), slide-up-fade, scale-in/out, pop (overshoot), rotate-in, spin, blur-in, typewriter, text-fade-up (per-character), wiggle, wiggle-rotation, pulse, float, rotate-continuous, blink, bounce (inertial overshoot after keys), loop (loopOut).", shape: { comp: Comp, layer: Layer, preset: z.enum(["fade-in", "fade-out", "slide-in", "slide-out", "slide-up-fade", "scale-in", "scale-out", "pop", "rotate-in", "spin", "blur-in", "typewriter", "text-fade-up", "wiggle", "wiggle-rotation", "pulse", "float", "rotate-continuous", "blink", "bounce", "loop"]), startTime: z.number().optional().describe("Default: layer in point (out-animations: end of layer)."), duration: z.number().positive().optional(), easing: Easing.optional(), direction: z.enum(["left", "right", "top", "bottom"]).optional(), amount: z.number().optional().describe("Preset strength: distance px, degrees, %, wiggle amplitude..."), frequency: z.number().optional(), decay: z.number().optional(), property: z.string().optional().describe("Target property for bounce/loop."), loopType: z.enum(["cycle", "pingpong", "offset", "continue"]).optional(), targetValue: z.number().optional() } }),

  // ------------------------------------------------------------- effects
  t({ category: "effects", name: "list_available_effects", readOnly: true, title: "Search effects", description: "Search all installed effects (incl. third-party plugins) by name, match name or category.", shape: { query: z.string().optional(), category: z.string().optional(), limit: z.number().int().optional() } }),
  t({ category: "effects", name: "apply_effect", title: "Apply effect", description: "Apply any effect by display name or match name to one or many layers and set parameters by name/match name/index. Param value can be {keyframes:[...]} or {expression:'...'}. Returns all parameters with their values.", shape: { comp: Comp, layer: LayerOpt, layers: Layers.optional(), effect: z.string().describe("e.g. 'Gaussian Blur', 'ADBE Glo2', 'Fill', 'CC Particle World'"), name: z.string().optional(), params: z.record(z.any()).optional(), returnParams: z.boolean().optional() } }),
  t({ category: "effects", name: "get_layer_effects", readOnly: true, title: "Layer effects", description: "List effects on a layer with every parameter value.", shape: { comp: Comp, layer: Layer } }),
  t({ category: "effects", name: "modify_effect", title: "Modify effect", description: "Change parameters of an effect already on a layer, rename, enable/disable, reorder, duplicate or remove it.", shape: { comp: Comp, layer: Layer, effect: z.union([z.string(), z.number()]).describe("Effect name or 1-based index in the layer's stack."), params: z.record(z.any()).optional(), enabled: z.boolean().optional(), newName: z.string().optional(), moveTo: z.number().int().optional(), duplicate: z.boolean().optional(), remove: z.boolean().optional() } }),
  t({ category: "effects", name: "apply_effect_template", title: "Effect look template", description: "Apply a ready-made look: gaussian-blur, directional-blur, glow, soft-glow, neon, drop-shadow, long-shadow, brightness-contrast, vibrance, black-and-white, sepia, vignette, cinematic-look, text-pop, film-grain, chromatic-aberration, sharpen, posterize-time.", shape: { comp: Comp, layer: LayerOpt, layers: Layers.optional(), template: z.enum(["gaussian-blur", "directional-blur", "glow", "soft-glow", "neon", "drop-shadow", "long-shadow", "brightness-contrast", "vibrance", "black-and-white", "sepia", "vignette", "cinematic-look", "text-pop", "film-grain", "chromatic-aberration", "sharpen", "posterize-time"]), params: z.record(z.any()).optional() } }),
  t({ category: "effects", name: "apply_preset_file", title: "Apply .ffx preset", description: "Apply an Animation Preset (.ffx) file to a layer.", shape: { comp: Comp, layer: Layer, presetPath: z.string(), time: z.number().optional() } }),

  // ------------------------------------------------------------- masks & markers
  t({ category: "masks", name: "add_mask", title: "Add mask", description: "Add a rectangle, ellipse or custom path mask with mode, feather, opacity, expansion and inversion. rect is [x,y,w,h] in layer space (default: layer bounds).", shape: { comp: Comp, layer: Layer, shape: z.enum(["rectangle", "ellipse", "path"]).optional(), rect: z.array(z.number()).length(4).optional(), vertices: z.array(z.array(z.number()).length(2)).optional(), inTangents: z.array(z.array(z.number()).length(2)).optional(), outTangents: z.array(z.array(z.number()).length(2)).optional(), closed: z.boolean().optional(), mode: z.enum(["add", "subtract", "intersect", "lighten", "darken", "difference", "none"]).optional(), inverted: z.boolean().optional(), feather: z.union([z.number(), z.array(z.number()).length(2)]).optional(), opacity: z.number().optional(), expansion: z.number().optional(), name: z.string().optional() } }),
  t({ category: "masks", name: "remove_masks", destructive: true, title: "Remove masks", description: "Remove one mask (by name or index) or all masks from a layer.", shape: { comp: Comp, layer: Layer, mask: z.union([z.string(), z.number()]).optional() } }),
  t({ category: "markers", name: "add_marker", title: "Add marker", description: "Add a comp marker (or a layer marker when layer is given) with comment, duration, chapter, URL and label.", shape: { comp: Comp, layer: Layer.optional(), time: z.number().optional(), comment: z.string().optional(), duration: z.number().optional(), chapter: z.string().optional(), url: z.string().optional(), label: z.number().int().optional() } }),
  t({ category: "markers", name: "list_markers", readOnly: true, title: "List markers", description: "List comp markers (and layer markers with includeLayers).", shape: { comp: Comp, includeLayers: z.boolean().optional() } }),
  t({ category: "markers", name: "remove_markers", destructive: true, title: "Remove markers", description: "Remove markers from a comp or layer, all or filtered by time/comment.", shape: { comp: Comp, layer: Layer.optional(), time: z.number().optional(), comment: z.string().optional() } }),

  // ------------------------------------------------------------- render & preview
  t({ category: "render", name: "preview_frame", handler: null, readOnly: true, title: "Preview frame (image)", description: "Render one frame of a composition and return it as an image, so you can SEE the result and check your work. maxSize downscales (default 960px).", shape: { comp: Comp, time: z.number().optional().describe("Seconds. Default: playhead."), maxSize: z.number().int().min(64).max(4096).optional(), savePath: z.string().optional().describe("Also keep the PNG at this path.") } }),
  t({ category: "render", name: "preview_contact_sheet", handler: null, readOnly: true, title: "Preview several frames", description: "Render N evenly spaced frames (or given times) of a comp and return them as images: a quick way to check an animation over time.", shape: { comp: Comp, frames: z.number().int().min(2).max(12).optional(), times: z.array(z.number()).max(12).optional(), maxSize: z.number().int().min(64).max(2048).optional() } }),
  t({ category: "render", name: "add_to_render_queue", title: "Add to render queue", description: "Queue a comp for rendering with an output path and format (h264/mp4, mov/prores, png sequence, lossless) or explicit templates. Returns available output templates.", shape: { comp: Comp, outputPath: z.string().optional(), format: z.enum(["h264", "mp4", "mov", "prores", "png", "lossless"]).optional(), outputModuleTemplate: z.string().optional(), renderSettingsTemplate: z.string().optional(), start: z.number().optional(), duration: z.number().optional(), workAreaOnly: z.boolean().optional() } }),
  t({ category: "render", name: "get_render_queue", readOnly: true, title: "Render queue", description: "List render queue items, status and output files.", shape: {} }),
  t({ category: "render", name: "clear_render_queue", destructive: true, title: "Clear render queue", description: "Remove render queue items (all, or only finished ones).", shape: { onlyDone: z.boolean().optional() } }),
  t({ category: "render", name: "render_queue", undo: false, title: "Render (blocking)", description: "Render the queue inside After Effects. AE is blocked until done; prefer render_in_background for long renders.", timeoutMs: 3600_000, shape: { timeoutSeconds: z.number().int().optional() } }),
  t({ category: "render", name: "render_in_background", handler: null, title: "Render in background (aerender)", description: "Render a comp with aerender in a separate process while you keep working in AE. Saves the project first. Track with get_background_render.", shape: { comp: z.string().describe("Composition name."), outputPath: z.string(), outputModuleTemplate: z.string().optional(), renderSettingsTemplate: z.string().optional(), startFrame: z.number().int().optional(), endFrame: z.number().int().optional() } }),
  t({ category: "render", name: "get_background_render", handler: null, readOnly: true, title: "Background render status", description: "Status, progress and log tail of background renders.", shape: { jobId: z.string().optional() } }),

  // ------------------------------------------------------------- utilities
  t({ category: "utility", name: "list_fonts", readOnly: true, title: "List fonts", description: "Search installed fonts; returns PostScript names to use in text tools (AE 2024+).", shape: { query: z.string().optional(), limit: z.number().int().optional() } }),
  t({ category: "utility", name: "get_selection", readOnly: true, title: "Get selection", description: "What the user has selected in AE right now: active comp, playhead, selected layers and properties. Great for 'animate this layer' requests.", shape: {} }),
  t({ category: "utility", name: "select_layers", title: "Select layers", description: "Select layers in the timeline (empty list clears the selection).", shape: { comp: Comp, layers: Layers.optional() } }),
  t({ category: "utility", name: "undo", undo: false, title: "Undo / redo", description: "Undo or redo the last After Effects steps. Every MCP call is a single undo step.", shape: { action: z.enum(["undo", "redo"]).optional(), steps: z.number().int().min(1).max(50).optional() } }),
  t({ category: "utility", name: "execute_menu_command", title: "Run menu command", description: "Execute an AE menu command by id or (English) menu name, e.g. 'Fit to Comp', 'Center Anchor Point in Layer Content'.", shape: { commandId: z.number().int().optional(), menuName: z.string().optional() } }),
  t({ category: "utility", name: "run_extendscript", title: "Run ExtendScript", description: "Escape hatch: run custom ExtendScript in After Effects. Code is a function body; use `return` to send back a value (comps/layers/properties are serialized). `AEMCP` helpers (getComp, getLayer, resolveProp, color...) and `args` are available. Disabled when AE_MCP_DISABLE_EVAL=1.", timeoutMs: 300_000, shape: { code: z.string(), args: z.record(z.any()).optional(), undoable: z.boolean().optional() } }),
  t({ category: "utility", name: "batch", title: "Batch operations", description: "Run several tools in ONE round trip and ONE undo step, e.g. create 10 layers and animate them. Each operation is {tool, args} using the same names/args as the individual tools (AE-side tools only).", timeoutMs: 300_000, shape: { operations: z.array(z.object({ tool: z.string(), args: z.record(z.any()).optional() })).min(1).max(200), continueOnError: z.boolean().optional() } }),
];

export const NODE_ONLY = new Set(TOOLS.filter((d) => d.handler === null).map((d) => d.name));
