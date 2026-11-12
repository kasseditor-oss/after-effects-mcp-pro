/*
 * AE MCP Pro - ExtendScript runtime.
 *
 * Loaded once per After Effects session (cached by hash in $.global.AEMCP).
 * Every MCP tool maps to a handler in AEMCP.handlers. The Node server writes a
 * tiny command script that calls AEMCP.run(payload, resultPath).
 *
 * Constraints: ExtendScript is ES3. No JSON, no Array.indexOf, no Object.keys,
 * no let/const, no arrow functions, no trailing commas.
 */
(function (G) {
    var A = {};
    A.version = "__AEMCP_VERSION__";
    A.hash = "__AEMCP_HASH__";

    // ------------------------------------------------------------------ JSON
    var JSONX = (function () {
        var esc = /[\\"\u0000-\u001f\u007f-\u009f\u00ad\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g;
        var meta = { "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r", "\"": "\\\"", "\\": "\\\\" };
        function quote(s) {
            esc.lastIndex = 0;
            return esc.test(s) ? "\"" + s.replace(esc, function (a) {
                var c = meta[a];
                return typeof c === "string" ? c : "\\u" + ("0000" + a.charCodeAt(0).toString(16)).slice(-4);
            }) + "\"" : "\"" + s + "\"";
        }
        function str(v, depth) {
            if (depth > 64) return "null";
            if (v === null || v === undefined) return "null";
            var t = typeof v;
            if (t === "number") return isFinite(v) ? String(v) : "null";
            if (t === "boolean") return String(v);
            if (t === "string") return quote(v);
            if (t === "function") return "null";
            if (v instanceof Array) {
                var a = [];
                for (var i = 0; i < v.length; i++) a.push(str(v[i], depth + 1));
                return "[" + a.join(",") + "]";
            }
            var parts = [];
            for (var k in v) {
                if (!v.hasOwnProperty(k)) continue;
                var val = v[k];
                if (val === undefined || typeof val === "function") continue;
                parts.push(quote(k) + ":" + str(val, depth + 1));
            }
            return "{" + parts.join(",") + "}";
        }
        function parse(text) {
            var cx = /[\u0000\u00ad\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g;
            text = String(text);
            cx.lastIndex = 0;
            if (cx.test(text)) {
                text = text.replace(cx, function (a) { return "\\u" + ("0000" + a.charCodeAt(0).toString(16)).slice(-4); });
            }
            if (/^[\],:{}\s]*$/.test(text.replace(/\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g, "@")
                .replace(/"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g, "]")
                .replace(/(?:^|:|,)(?:\s*\[)+/g, ""))) {
                return eval("(" + text + ")");
            }
            throw new Error("Invalid JSON payload");
        }
        return { stringify: function (v) { return str(v, 0); }, parse: parse };
    })();
    A.JSON = JSONX;

    // --------------------------------------------------------------- helpers
    function fail(msg, hint) {
        var e = new Error(msg);
        e.aeHint = hint;
        throw e;
    }
    A.fail = fail;

    function has(o, k) { return o !== null && o !== undefined && o.hasOwnProperty && o.hasOwnProperty(k) && o[k] !== undefined && o[k] !== null; }
    function def(v, d) { return (v === undefined || v === null) ? d : v; }
    function inArr(arr, v) { for (var i = 0; i < arr.length; i++) if (arr[i] === v) return true; return false; }
    function round(n, p) { var m = Math.pow(10, def(p, 4)); return Math.round(n * m) / m; }
    function lower(s) { return String(s).toLowerCase(); }

    // Colors: accept [r,g,b] (0..1), [r,g,b] (0..255), "#rrggbb", "#rgb", {r,g,b}
    function color(c, withAlpha) {
        var out;
        if (c === undefined || c === null) return undefined;
        if (typeof c === "string") {
            var h = c.replace(/^#/, "");
            if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
            if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(h)) fail("Invalid color '" + c + "'", "Use '#RRGGBB' or [r,g,b] with 0-1 values.");
            out = [parseInt(h.substr(0, 2), 16) / 255, parseInt(h.substr(2, 2), 16) / 255, parseInt(h.substr(4, 2), 16) / 255];
            if (h.length === 8) out.push(parseInt(h.substr(6, 2), 16) / 255);
        } else if (c instanceof Array) {
            out = [];
            var big = false;
            for (var i = 0; i < c.length; i++) if (c[i] > 1) big = true;
            for (i = 0; i < c.length; i++) out.push(big ? c[i] / 255 : c[i]);
        } else if (typeof c === "object") {
            var bigO = (c.r > 1 || c.g > 1 || c.b > 1);
            out = [c.r, c.g, c.b];
            for (i = 0; i < 3; i++) out[i] = bigO ? out[i] / 255 : out[i];
            if (c.a !== undefined) out.push(c.a > 1 ? c.a / 255 : c.a);
        } else fail("Invalid color value");
        if (withAlpha && out.length === 3) out.push(1);
        if (!withAlpha && out.length === 4) out = [out[0], out[1], out[2]];
        return out;
    }
    A.color = color;

    function toHex(c) {
        function p(n) { var s = Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16); return s.length < 2 ? "0" + s : s; }
        return "#" + p(c[0]) + p(c[1]) + p(c[2]);
    }

    // ---------------------------------------------------- project item lookup
    function allItems() {
        var out = [];
        if (!app.project) return out;
        for (var i = 1; i <= app.project.numItems; i++) out.push(app.project.item(i));
        return out;
    }
    function itemType(it) {
        if (it instanceof CompItem) return "composition";
        if (it instanceof FolderItem) return "folder";
        if (it instanceof FootageItem) {
            if (it.mainSource instanceof SolidSource) return "solid";
            if (it.mainSource instanceof PlaceholderSource) return "placeholder";
            if (it.mainSource && it.mainSource.isStill) return "still";
            if (it.hasVideo) return "video";
            if (it.hasAudio) return "audio";
            return "footage";
        }
        return "unknown";
    }
    // Project folder by path: "Assets/Images/Logos" (each level created when create is true).
    // An exact folder name containing "/" still wins, for projects that use such names.
    function folderPath(pathStr, create) {
        var root = app.project.rootFolder;
        if (pathStr === undefined || pathStr === null || pathStr === "" || pathStr === "/") return root;
        if (typeof pathStr === "number" || /^id:\d+$/.test(String(pathStr))) {
            var byId = findItem(pathStr);
            if (!(byId instanceof FolderItem)) fail("Item " + pathStr + " is not a folder");
            return byId;
        }
        var exact = findItem(String(pathStr), function (it) { return it instanceof FolderItem; });
        if (exact) return exact;
        var parts = String(pathStr).replace(/^\/+|\/+$/g, "").split(/\s*\/\s*/);
        var cur = root;
        for (var i = 0; i < parts.length; i++) {
            var next = null;
            for (var j = 1; j <= cur.numItems; j++) {
                var it = cur.item(j);
                if (it instanceof FolderItem && lower(it.name) === lower(parts[i])) { next = it; break; }
            }
            if (!next) {
                if (!create) fail("Folder '" + pathStr + "' not found (missing '" + parts[i] + "')");
                next = app.project.items.addFolder(parts[i]);
                next.parentFolder = cur;
            }
            cur = next;
        }
        return cur;
    }
    A.folderPath = folderPath;
    function folderName(f) {
        if (!f || f === app.project.rootFolder) return null;
        var parts = [];
        while (f && f !== app.project.rootFolder) { parts.unshift(f.name); f = f.parentFolder; }
        return parts.join("/");
    }

    // Create the parent folders of an output file, like mkdir -p. Returns the File.
    function outFile(p) {
        var f = new File(p);
        var dirs = [], d = f.parent;
        while (d && !d.exists) { dirs.unshift(d); d = d.parent; }
        for (var i = 0; i < dirs.length; i++) if (!dirs[i].create()) fail("Cannot create folder " + dirs[i].fsName, "Check the path and write permissions.");
        return f;
    }
    A.outFile = outFile;

    function findItem(ref, typeFilter) {
        if (ref === undefined || ref === null || ref === "") return null;
        if (typeof ref === "number") {
            try { var quick = app.project.itemByID(ref); if (quick) return quick; } catch (eq) { }
        }
        var items = allItems();
        var i, it;
        if (typeof ref === "number") {
            try { var byId = app.project.itemByID(ref); if (byId) return byId; } catch (e0) { }
            for (i = 0; i < items.length; i++) if (items[i].id === ref) return items[i];
            fail("Project item with id " + ref + " not found");
        }
        if (typeof ref === "object" && has(ref, "id")) return findItem(Number(ref.id), typeFilter);
        var s = String(ref);
        if (/^id:\d+$/.test(s)) return findItem(parseInt(s.substr(3), 10), typeFilter);
        for (i = 0; i < items.length; i++) {
            it = items[i];
            if (it.name === s && (!typeFilter || typeFilter(it))) return it;
        }
        for (i = 0; i < items.length; i++) {
            it = items[i];
            if (lower(it.name) === lower(s) && (!typeFilter || typeFilter(it))) return it;
        }
        return null;
    }
    A.findItem = findItem;

    function isComp(it) { return it instanceof CompItem; }

    function getComp(ref, optional) {
        if (!app.project) fail("No project is open in After Effects");
        if (ref === undefined || ref === null || ref === "") {
            var ai = app.project.activeItem;
            if (ai instanceof CompItem) return ai;
            // Fallback: the comp open in the active viewer, then the only comp in the project
            try {
                if (app.activeViewer && app.activeViewer.type === ViewerType.VIEWER_COMPOSITION) {
                    app.activeViewer.setActive();
                    if (app.project.activeItem instanceof CompItem) return app.project.activeItem;
                }
            } catch (e) { }
            var comps = [];
            var items = allItems();
            for (var i = 0; i < items.length; i++) if (items[i] instanceof CompItem) comps.push(items[i]);
            if (comps.length === 1) return comps[0];
            if (optional) return null;
            fail("No composition specified and no active composition", comps.length ? "Pass 'comp' (name or id). Available: " + compNames(comps) : "Create one with create_composition.");
        }
        var c = findItem(ref, isComp);
        if (!c || !(c instanceof CompItem)) {
            if (optional) return null;
            fail("Composition '" + ref + "' not found", "Available: " + compNames());
        }
        return c;
    }
    A.getComp = getComp;

    // "a, b, c ... and 12 more": hints stay short even in huge projects
    function shortList(names, total) {
        var more = total - names.length;
        return names.join(", ") + (more > 0 ? " ... and " + more + " more" : "");
    }

    function compNames(list) {
        var names = [];
        var items = list || allItems();
        var total = 0;
        for (var i = 0; i < items.length; i++) if (items[i] instanceof CompItem) { total++; if (names.length < 10) names.push(items[i].name + " (id " + items[i].id + ")"); }
        return names.length ? shortList(names, total) : "(none)";
    }

    function getLayer(comp, ref) {
        if (ref === undefined || ref === null || ref === "") {
            var sel = comp.selectedLayers;
            if (sel && sel.length === 1) return sel[0];
            fail("No layer specified", "Pass 'layer' as a 1-based index, a name, or 'id:<layerId>'.");
        }
        if (typeof ref === "number") {
            if (ref < 1 || ref > comp.numLayers) fail("Layer index " + ref + " out of range (comp '" + comp.name + "' has " + comp.numLayers + " layers)");
            return comp.layer(ref);
        }
        if (typeof ref === "object" && has(ref, "id")) ref = "id:" + ref.id;
        var s = String(ref);
        if (/^id:\d+$/.test(s)) {
            var id = parseInt(s.substr(3), 10);
            for (var i = 1; i <= comp.numLayers; i++) if (comp.layer(i).id === id) return comp.layer(i);
            fail("Layer with id " + id + " not found in '" + comp.name + "'");
        }
        if (/^\d+$/.test(s)) return getLayer(comp, parseInt(s, 10));
        for (i = 1; i <= comp.numLayers; i++) if (comp.layer(i).name === s) return comp.layer(i);
        for (i = 1; i <= comp.numLayers; i++) if (lower(comp.layer(i).name) === lower(s)) return comp.layer(i);
        var names = [];
        for (i = 1; i <= Math.min(comp.numLayers, 10); i++) names.push(i + ":" + comp.layer(i).name);
        fail("Layer '" + s + "' not found in '" + comp.name + "'", "Layers: " + (names.length ? shortList(names, comp.numLayers) : "(none)"));
    }
    A.getLayer = getLayer;

    function getLayers(comp, refs) {
        if (refs === undefined || refs === null) {
            var sel = comp.selectedLayers;
            if (sel && sel.length) { var a = []; for (var j = 0; j < sel.length; j++) a.push(sel[j]); return a; }
            fail("No layers specified and nothing selected");
        }
        if (!(refs instanceof Array)) refs = [refs];
        var out = [];
        for (var i = 0; i < refs.length; i++) out.push(getLayer(comp, refs[i]));
        return out;
    }
    A.getLayers = getLayers;

    function target(args) {
        var comp = getComp(args.comp);
        var layer = getLayer(comp, args.layer);
        return { comp: comp, layer: layer };
    }

    // ------------------------------------------------------ property lookup
    // Locale-independent aliases -> match names. Display names in non-English
    // After Effects differ, match names never do.
    var ALIAS = {
        "transform": "ADBE Transform Group", "anchor point": "ADBE Anchor Point", "anchor": "ADBE Anchor Point",
        "position": "ADBE Position", "x position": "ADBE Position_0", "y position": "ADBE Position_1", "z position": "ADBE Position_2",
        "scale": "ADBE Scale", "rotation": "ADBE Rotate Z", "z rotation": "ADBE Rotate Z", "x rotation": "ADBE Rotate X",
        "y rotation": "ADBE Rotate Y", "orientation": "ADBE Orientation", "opacity": "ADBE Opacity",
        "effects": "ADBE Effect Parade", "masks": "ADBE Mask Parade", "contents": "ADBE Root Vectors Group",
        "text": "ADBE Text Properties", "source text": "ADBE Text Document", "path options": "ADBE Text Path Options",
        "more options": "ADBE Text More Options", "animators": "ADBE Text Animators",
        "time remap": "ADBE Time Remapping", "time remapping": "ADBE Time Remapping",
        "material options": "ADBE Material Options Group", "audio": "ADBE Audio Group", "audio levels": "ADBE Audio Levels",
        "camera options": "ADBE Camera Options Group", "zoom": "ADBE Camera Zoom", "depth of field": "ADBE Camera Depth of Field",
        "focus distance": "ADBE Camera Focus Distance", "aperture": "ADBE Camera Aperture", "blur level": "ADBE Camera Blur Level",
        "light options": "ADBE Light Options Group", "intensity": "ADBE Light Intensity", "color": "ADBE Light Color",
        "cone angle": "ADBE Light Cone Angle", "cone feather": "ADBE Light Cone Feather 2", "point of interest": "ADBE Anchor Point",
        "mask path": "ADBE Mask Shape", "mask feather": "ADBE Mask Feather", "mask opacity": "ADBE Mask Opacity", "mask expansion": "ADBE Mask Offset"
    };
    var TRANSFORM_KEYS = { "ADBE Anchor Point": 1, "ADBE Position": 1, "ADBE Position_0": 1, "ADBE Position_1": 1, "ADBE Position_2": 1, "ADBE Scale": 1, "ADBE Rotate Z": 1, "ADBE Rotate X": 1, "ADBE Rotate Y": 1, "ADBE Orientation": 1, "ADBE Opacity": 1 };

    function child(group, seg) {
        var p = null;
        if (typeof seg === "number" || /^\d+$/.test(seg)) {
            var n = Number(seg);
            if (n >= 1 && n <= group.numProperties) return group.property(n);
            return null;
        }
        var al = ALIAS[lower(seg)];
        if (al) { try { p = group.property(al); } catch (e) { p = null; } if (p) return p; }
        try { p = group.property(seg); } catch (e2) { p = null; }
        if (p) return p;
        // case-insensitive scan on name and matchName
        for (var i = 1; i <= group.numProperties; i++) {
            var c = group.property(i);
            if (lower(c.name) === lower(seg) || lower(c.matchName) === lower(seg)) return c;
        }
        return null;
    }

    function splitPath(path) {
        if (path instanceof Array) return path;
        return String(path).split(/\s*[\/>]\s*/);
    }

    function resolveProp(layer, path) {
        var segs = splitPath(path);
        var cur = layer;
        for (var i = 0; i < segs.length; i++) {
            var seg = segs[i];
            if (seg === "") continue;
            var next = child(cur, seg);
            if (!next && cur === layer) {
                // Shortcut: transform props, text props, camera/light options, effects by name
                var al = ALIAS[lower(seg)];
                if (al && TRANSFORM_KEYS[al]) next = layer.property("ADBE Transform Group").property(al);
                if (!next) {
                    var groups = ["ADBE Transform Group", "ADBE Text Properties", "ADBE Camera Options Group", "ADBE Light Options Group", "ADBE Effect Parade", "ADBE Material Options Group", "ADBE Audio Group"];
                    for (var g = 0; g < groups.length && !next; g++) {
                        var grp = null;
                        try { grp = layer.property(groups[g]); } catch (e) { grp = null; }
                        if (grp) next = child(grp, seg);
                    }
                }
            }
            if (!next) {
                var avail = [];
                var nKids = 0;
                try { nKids = cur.numProperties; for (var k = 1; k <= Math.min(nKids, 10); k++) avail.push(cur.property(k).name + " [" + cur.property(k).matchName + "]"); } catch (e3) { }
                fail("Property '" + seg + "' not found under '" + (cur === layer ? layer.name : cur.name) + "'", avail.length ? "Children: " + shortList(avail, nKids) : undefined);
            }
            // flat effect topics (Lumetri): "Vignette" is a NO_VALUE parameter and its
            // parameters are the following siblings, up to a blank-named NO_VALUE one
            if (isProperty(next) && next.propertyValueType === PropertyValueType.NO_VALUE && i < segs.length - 1 && !isProperty(cur)) {
                var found = null, depthT = 0;
                for (var q = next.propertyIndex + 1; q <= cur.numProperties && !found; q++) {
                    var sib = cur.property(q);
                    if (isProperty(sib) && sib.propertyValueType === PropertyValueType.NO_VALUE) {
                        if (blank(sib.name)) { if (depthT === 0) break; depthT--; } else depthT++;
                        continue;
                    }
                    if (depthT === 0 && (lower(sib.name) === lower(segs[i + 1]) || lower(sib.matchName) === lower(segs[i + 1]))) found = sib;
                }
                if (found) { cur = found; i++; continue; }
            }
            cur = next;
        }
        return cur;
    }
    A.resolveProp = resolveProp;

    function propPath(p) {
        var parts = [];
        var cur = p;
        while (cur && cur.parentProperty) { parts.unshift(cur.name); cur = cur.parentProperty; }
        return parts.join("/");
    }

    function isProperty(p) { return p && p.propertyType === PropertyType.PROPERTY; }

    // -------------------------------------------------------- value (de)ser
    // In AE 2026 marker values fail instanceof MarkerValue: recognise them by shape.
    function isMarkerLike(v) {
        try { return typeof v === "object" && typeof v.comment === "string" && typeof v.duration === "number" && v.chapter !== undefined; } catch (e) { return false; }
    }
    function serMarker(v) {
        var o = { comment: v.comment, duration: round(v.duration), chapter: v.chapter, url: v.url, label: v.label };
        try { o.protectedRegion = v.protectedRegion; } catch (e) { }
        return o;
    }

    function serValue(v) {
        if (v === null || v === undefined) return null;
        if (typeof v === "number") return round(v, 4);
        if (typeof v === "string" || typeof v === "boolean") return v;
        if (v instanceof Array) { var a = []; for (var i = 0; i < v.length; i++) a.push(serValue(v[i])); return a; }
        if (v instanceof TextDocument) return serText(v);
        if (v instanceof Shape) return { vertices: serValue(v.vertices), inTangents: serValue(v.inTangents), outTangents: serValue(v.outTangents), closed: v.closed };
        if (v instanceof MarkerValue || isMarkerLike(v)) return serMarker(v);
        return String(v);
    }
    A.serValue = serValue;

    function serText(td) {
        var o = { text: td.text };
        try { o.font = td.font; o.fontSize = td.fontSize; } catch (e) { }
        try { o.applyFill = td.applyFill; if (td.applyFill) o.fillColor = toHex(td.fillColor); } catch (e2) { }
        try { o.applyStroke = td.applyStroke; if (td.applyStroke) { o.strokeColor = toHex(td.strokeColor); o.strokeWidth = td.strokeWidth; } } catch (e3) { }
        try { o.tracking = td.tracking; o.leading = td.leading; o.autoLeading = td.autoLeading; } catch (e4) { }
        try { o.justification = justName(td.justification); } catch (e5) { }
        try { o.boxText = td.boxText; if (td.boxText) o.boxTextSize = td.boxTextSize; } catch (e6) { }
        try { o.caps = capsName(td); o.allCaps = o.caps === "all"; o.fauxBold = td.fauxBold; o.fauxItalic = td.fauxItalic; } catch (e7) { }
        return o;
    }

    function justName(j) {
        if (j === ParagraphJustification.LEFT_JUSTIFY) return "left";
        if (j === ParagraphJustification.RIGHT_JUSTIFY) return "right";
        if (j === ParagraphJustification.CENTER_JUSTIFY) return "center";
        return "justify";
    }
    function justValue(s) {
        s = lower(s);
        if (s === "left") return ParagraphJustification.LEFT_JUSTIFY;
        if (s === "right") return ParagraphJustification.RIGHT_JUSTIFY;
        if (s === "center") return ParagraphJustification.CENTER_JUSTIFY;
        if (s === "justify" || s === "full") return ParagraphJustification.FULL_JUSTIFY_LASTLINE_LEFT;
        fail("Unknown justification '" + s + "'", "Use left, center, right or justify.");
    }

    var CAPS = { "normal": "FONT_NORMAL_CAPS", "all": "FONT_ALL_CAPS", "small": "FONT_SMALL_CAPS", "all-small": "FONT_ALL_SMALL_CAPS" };
    function setCaps(td, caps) {
        if (typeof FontCapsOption !== "undefined") {
            var k = CAPS[caps];
            if (!k) fail("Unknown caps '" + caps + "'", "Use normal, all, small or all-small.");
            td.fontCapsOption = FontCapsOption[k];
        } else {
            // AE before 24.0: only allCaps / smallCaps booleans exist
            td.allCaps = caps === "all" || caps === "all-small";
            try { td.smallCaps = caps === "small" || caps === "all-small"; } catch (e) { }
        }
    }
    function capsName(td) {
        try {
            if (typeof FontCapsOption !== "undefined") {
                for (var k in CAPS) if (CAPS.hasOwnProperty(k) && td.fontCapsOption === FontCapsOption[CAPS[k]]) return k;
            }
            return td.allCaps ? "all" : (td.smallCaps ? "small" : "normal");
        } catch (e) { return null; }
    }
    A.capsName = capsName;

    function applyTextStyle(td, s) {
        if (has(s, "text")) td.text = String(s.text);
        if (has(s, "font")) td.font = s.font;
        if (has(s, "fontSize")) td.fontSize = s.fontSize;
        if (has(s, "fillColor") || has(s, "color")) { td.applyFill = true; td.fillColor = color(def(s.fillColor, s.color)); }
        if (has(s, "applyFill")) td.applyFill = !!s.applyFill;
        if (has(s, "strokeColor")) { td.applyStroke = true; td.strokeColor = color(s.strokeColor); }
        if (has(s, "strokeWidth")) { td.applyStroke = s.strokeWidth > 0; td.strokeWidth = s.strokeWidth; }
        if (has(s, "strokeOverFill")) td.strokeOverFill = !!s.strokeOverFill;
        if (has(s, "tracking")) td.tracking = s.tracking;
        if (has(s, "leading")) { td.autoLeading = false; td.leading = s.leading; }
        if (has(s, "justification")) td.justification = justValue(s.justification);
        if (has(s, "caps")) setCaps(td, s.caps);
        else if (has(s, "allCaps")) setCaps(td, s.allCaps ? "all" : "normal");
        if (has(s, "fauxBold")) td.fauxBold = !!s.fauxBold;
        if (has(s, "fauxItalic")) td.fauxItalic = !!s.fauxItalic;
        if (has(s, "baselineShift")) td.baselineShift = s.baselineShift;
        return td;
    }

    function toShape(v) {
        if (v instanceof Shape) return v;
        var sh = new Shape();
        sh.vertices = v.vertices;
        var n = v.vertices.length;
        var zeros = [];
        for (var i = 0; i < n; i++) zeros.push([0, 0]);
        sh.inTangents = v.inTangents || zeros;
        sh.outTangents = v.outTangents || zeros;
        sh.closed = def(v.closed, true);
        return sh;
    }

    function coerce(prop, v) {
        var t = prop.propertyValueType;
        if (t === PropertyValueType.TEXT_DOCUMENT) {
            var td = prop.value;
            if (typeof v === "string") { td.text = v; return td; }
            return applyTextStyle(td, v);
        }
        if (t === PropertyValueType.SHAPE) return toShape(v);
        if (t === PropertyValueType.COLOR) return color(v, true);
        if (t === PropertyValueType.MARKER) {
            var m = new MarkerValue(def(v.comment, ""));
            if (has(v, "duration")) m.duration = v.duration;
            return m;
        }
        if (typeof v === "boolean") return v ? 1 : 0;
        if ((t === PropertyValueType.TwoD_SPATIAL || t === PropertyValueType.ThreeD_SPATIAL || t === PropertyValueType.TwoD || t === PropertyValueType.ThreeD) && v instanceof Array) {
            // Pad/trim to the property's dimension so [x,y] works on 3D layers and vice versa.
            var cur = prop.value;
            if (cur instanceof Array) {
                var out = [];
                for (var i = 0; i < cur.length; i++) out.push(i < v.length ? v[i] : cur[i]);
                return out;
            }
        }
        if (t === PropertyValueType.OneD && v instanceof Array) return v[0];
        return v;
    }
    A.coerce = coerce;

    function expectedType(p) {
        var t = p.propertyValueType;
        if (t === PropertyValueType.OneD) return "a number";
        if (t === PropertyValueType.TwoD || t === PropertyValueType.TwoD_SPATIAL) return "[x, y]";
        if (t === PropertyValueType.ThreeD || t === PropertyValueType.ThreeD_SPATIAL) return "[x, y, z] (or [x, y])";
        if (t === PropertyValueType.COLOR) return "a color: '#RRGGBB' or [r, g, b] (0-1)";
        if (t === PropertyValueType.TEXT_DOCUMENT) return "a string, or {text, font, fontSize, fillColor, ...}";
        if (t === PropertyValueType.SHAPE) return "{vertices: [[x,y],...], inTangents?, outTangents?, closed?}";
        if (t === PropertyValueType.MARKER) return "{comment, duration?}";
        if (t === PropertyValueType.LAYER_INDEX) return "a layer index";
        if (t === PropertyValueType.MASK_INDEX) return "a mask index";
        return "a value of this property's type";
    }

    function propInfo(p, withKeys) {
        var o = { name: p.name, matchName: p.matchName, path: propPath(p) };
        if (!isProperty(p)) { o.group = true; o.numProperties = p.numProperties; return o; }
        try { if (p.propertyValueType !== PropertyValueType.NO_VALUE && p.propertyValueType !== PropertyValueType.CUSTOM_VALUE) o.value = serValue(p.value); } catch (e) { }
        o.canKeyframe = p.canVaryOverTime;
        o.numKeys = p.numKeys;
        if (p.canSetExpression && p.expression) { o.expression = p.expression; o.expressionEnabled = p.expressionEnabled; if (p.expressionError) o.expressionError = p.expressionError; }
        if (withKeys && p.numKeys > 0) {
            o.keyframes = [];
            for (var k = 1; k <= p.numKeys; k++) o.keyframes.push({ index: k, time: round(p.keyTime(k), 4), value: serValue(p.keyValue(k)), inInterpolation: interpName(p.keyInInterpolationType(k)), outInterpolation: interpName(p.keyOutInterpolationType(k)) });
        }
        return o;
    }

    function interpName(t) {
        if (t === KeyframeInterpolationType.LINEAR) return "linear";
        if (t === KeyframeInterpolationType.HOLD) return "hold";
        return "bezier";
    }

    // ------------------------------------------------------------ layer info
    function layerType(l) {
        if (l instanceof TextLayer) return "text";
        if (l instanceof ShapeLayer) return "shape";
        if (l instanceof CameraLayer) return "camera";
        if (l instanceof LightLayer) return "light";
        if (l instanceof AVLayer) {
            if (l.adjustmentLayer) return "adjustment";
            if (l.nullLayer) return "null";
            if (l.source instanceof CompItem) return "precomp";
            if (l.source && l.source.mainSource instanceof SolidSource) return "solid";
            if (l.source && l.source.mainSource && l.source.mainSource.isStill) return "image";
            if (l.source && l.source.hasVideo) return "video";
            if (l.source && l.source.hasAudio) return "audio";
            return "av";
        }
        return "layer";
    }

    var BLEND = {
        "normal": "NORMAL", "dissolve": "DISSOLVE", "darken": "DARKEN", "multiply": "MULTIPLY", "color burn": "COLOR_BURN", "linear burn": "LINEAR_BURN",
        "darker color": "DARKER_COLOR", "add": "ADD", "lighten": "LIGHTEN", "screen": "SCREEN", "color dodge": "COLOR_DODGE", "linear dodge": "LINEAR_DODGE",
        "lighter color": "LIGHTER_COLOR", "overlay": "OVERLAY", "soft light": "SOFT_LIGHT", "hard light": "HARD_LIGHT", "linear light": "LINEAR_LIGHT",
        "vivid light": "VIVID_LIGHT", "pin light": "PIN_LIGHT", "hard mix": "HARD_MIX", "difference": "DIFFERENCE", "exclusion": "EXCLUSION",
        "subtract": "SUBTRACT", "divide": "DIVIDE", "hue": "HUE", "saturation": "SATURATION", "color": "COLOR", "luminosity": "LUMINOSITY",
        "stencil alpha": "STENCIL_ALPHA", "stencil luma": "STENCIL_LUMA", "silhouette alpha": "SILHOUETE_ALPHA", "silhouette luma": "SILHOUETTE_LUMA",
        "alpha add": "ALPHA_ADD", "luminescent premul": "LUMINESCENT_PREMUL"
    };
    function blendValue(s) {
        var k = BLEND[lower(String(s).replace(/[_\-]/g, " "))];
        if (!k || BlendingMode[k] === undefined) fail("Unknown blend mode '" + s + "'");
        return BlendingMode[k];
    }
    function blendName(v) {
        for (var k in BLEND) if (BLEND.hasOwnProperty(k) && BlendingMode[BLEND[k]] === v) return k;
        return String(v);
    }

    function matteName(l) {
        try {
            var t = l.trackMatteType;
            if (t === TrackMatteType.NO_TRACK_MATTE) return null;
            if (t === TrackMatteType.ALPHA) return "alpha";
            if (t === TrackMatteType.ALPHA_INVERTED) return "alpha-inverted";
            if (t === TrackMatteType.LUMA) return "luma";
            if (t === TrackMatteType.LUMA_INVERTED) return "luma-inverted";
        } catch (e) { }
        return null;
    }

    function layerSummary(l) {
        var o = { index: l.index, id: l.id, name: l.name, type: layerType(l), enabled: l.enabled, locked: l.locked, shy: l.shy, solo: l.solo,
            inPoint: round(l.inPoint), outPoint: round(l.outPoint), startTime: round(l.startTime), label: l.label };
        if (l.parent) o.parent = { index: l.parent.index, name: l.parent.name };
        if (l instanceof AVLayer) {
            o.threeD = l.threeDLayer;
            o.blendMode = blendName(l.blendingMode);
            o.motionBlur = l.motionBlur;
            var m = matteName(l);
            if (m) { o.trackMatte = m; try { if (l.trackMatteLayer) o.trackMatteLayer = l.trackMatteLayer.name; } catch (e) { } }
            if (l.source) o.source = { id: l.source.id, name: l.source.name };
            o.adjustment = l.adjustmentLayer;
        }
        try {
            var tg = l.property("ADBE Transform Group");
            o.transform = { position: serValue(tg.property("ADBE Position").value), scale: serValue(tg.property("ADBE Scale").value), rotation: serValue(tg.property("ADBE Rotate Z").value), opacity: serValue(tg.property("ADBE Opacity").value), anchorPoint: serValue(tg.property("ADBE Anchor Point").value) };
        } catch (e2) { }
        try { var fx = l.property("ADBE Effect Parade"); if (fx && fx.numProperties) { o.effects = []; for (var i = 1; i <= fx.numProperties; i++) o.effects.push(fx.property(i).name); } } catch (e3) { }
        if (l instanceof TextLayer) {
            // summaries stay small: full text is in get_layer_details / get_property "Source Text"
            try {
                var txt = l.property("ADBE Text Properties").property("ADBE Text Document").value.text;
                if (txt.length > 200) { o.text = txt.substr(0, 200); o.textLength = txt.length; o.textTruncated = true; } else o.text = txt;
            } catch (e4) { }
        }
        return o;
    }
    A.layerSummary = layerSummary;

    // compact: index, id, name, type, in/out, parent. fields: any subset of the full summary.
    var COMPACT = ["index", "id", "name", "type", "inPoint", "outPoint", "parent"];
    function shapeLayer(l, a) {
        if (!a.compact && !a.fields) return layerSummary(l);
        var keys = a.fields || COMPACT;
        var full = { index: l.index, id: l.id, name: l.name, type: layerType(l), inPoint: round(l.inPoint), outPoint: round(l.outPoint) };
        if (l.parent) full.parent = l.parent.index;
        var needFull = false;
        for (var i = 0; i < keys.length; i++) if (!full.hasOwnProperty(keys[i]) && keys[i] !== "parent") needFull = true;
        if (needFull) { var ls = layerSummary(l); for (var k in ls) if (ls.hasOwnProperty(k) && !full.hasOwnProperty(k)) full[k] = ls[k]; }
        var o = {};
        for (var j = 0; j < keys.length; j++) if (full[keys[j]] !== undefined) o[keys[j]] = full[keys[j]];
        // compact: in/out omitted when the layer spans the whole comp (the common case)
        if (a.compact && !a.fields) {
            var cd = l.containingComp.duration;
            if (Math.abs(l.inPoint) < 1e-6 && Math.abs(l.outPoint - cd) < 1e-6) { delete o.inPoint; delete o.outPoint; }
        }
        return o;
    }

    function page(list, a) {
        var off = Math.max(0, def(a.offset, 0)), lim = Math.max(1, Math.min(1000, def(a.limit, 200)));
        return { list: list.slice(off, off + lim), offset: off, truncated: off + lim < list.length };
    }

    // Inside a non-verbose batch, create/edit tools skip the full layer summary: it costs
    // property reads on every operation and made batch answers tens of KB.
    function summary(l) {
        if (A._lean) return { index: l.index, id: l.id, name: l.name, type: layerType(l) };
        return layerSummary(l);
    }

    function compSummary(c) {
        return { id: c.id, name: c.name, width: c.width, height: c.height, pixelAspect: c.pixelAspect, duration: round(c.duration), frameRate: round(c.frameRate, 3),
            numLayers: c.numLayers, bgColor: toHex(c.bgColor), workAreaStart: round(c.workAreaStart), workAreaDuration: round(c.workAreaDuration), time: round(c.time),
            folder: folderName(c.parentFolder) };
    }
    A.compSummary = compSummary;

    function dumpProps(group, depth, maxDepth, withKeys, onlyAnimated) {
        var out = [];
        for (var i = 1; i <= group.numProperties; i++) {
            var p = group.property(i);
            if (!p) continue;
            try { if (p.propertyType !== PropertyType.PROPERTY && !p.enabled && p.numProperties === 0) continue; } catch (e) { }
            if (isProperty(p)) {
                if (onlyAnimated && p.numKeys === 0 && !(p.canSetExpression && p.expression)) continue;
                if (!onlyAnimated && !p.isModified && depth > 1 && !p.numKeys) continue;
                out.push(propInfo(p, withKeys));
            } else if (depth < maxDepth) {
                var kids = dumpProps(p, depth + 1, maxDepth, withKeys, onlyAnimated);
                if (kids.length || !onlyAnimated) out.push({ name: p.name, matchName: p.matchName, children: kids });
            }
        }
        return out;
    }

    // ---------------------------------------------------- keyframe utilities
    function easeArrayLen(prop) {
        var t = prop.propertyValueType;
        if (t === PropertyValueType.TwoD_SPATIAL || t === PropertyValueType.ThreeD_SPATIAL) return 1;
        if (t === PropertyValueType.TwoD) return 2;
        if (t === PropertyValueType.ThreeD) return 3;
        return 1;
    }
    function easeArr(prop, speed, influence) {
        var n = easeArrayLen(prop), a = [];
        for (var i = 0; i < n; i++) a.push(new KeyframeEase(speed, Math.max(0.1, Math.min(100, influence))));
        return a;
    }
    var EASE_PRESETS = {
        "linear": null,
        "easy-ease": [33.33, 33.33], "ease-in-out": [33.33, 33.33],
        "ease-in": [33.33, 0.1], "ease-out": [0.1, 33.33],
        "smooth": [60, 60], "strong-ease": [85, 85], "expo": [90, 90],
        "snap": [95, 20], "anticipate": [20, 95]
    };
    // easing preset name -> [inInfluence (arriving), outInfluence (leaving)]
    function applyEase(prop, k, ease, kf) {
        var e = def(kf && kf.easing, ease);
        if (kf && (has(kf, "easeIn") || has(kf, "easeOut"))) {
            prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
            var ei = def(kf.easeIn, { speed: 0, influence: 33.33 });
            var eo = def(kf.easeOut, { speed: 0, influence: 33.33 });
            prop.setTemporalEaseAtKey(k, easeArr(prop, def(ei.speed, 0), def(ei.influence, 33.33)), easeArr(prop, def(eo.speed, 0), def(eo.influence, 33.33)));
            return;
        }
        if (!e) return;
        e = lower(e);
        if (e === "hold") { prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD); return; }
        if (e === "linear") { prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR); return; }
        var pr = EASE_PRESETS[e];
        if (pr === undefined) fail("Unknown easing '" + e + "'", "Use linear, hold, easy-ease, ease-in, ease-out, smooth, strong-ease, expo, snap, anticipate.");
        prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
        var isFirst = k === 1, isLast = k === prop.numKeys;
        var inInf = pr[0], outInf = pr[1];
        prop.setTemporalEaseAtKey(k, easeArr(prop, 0, isFirst ? 33.33 : inInf), easeArr(prop, 0, isLast ? 33.33 : outInf));
    }

    // CSS-style cubic-bezier(x1,y1,x2,y2) for the segment key k -> k+1. AE's temporal ease is
    // the same curve in the value graph: outgoing handle at x1 of the duration with speed
    // y1/x1 * average speed, incoming handle at (1 - x2) with speed (1-y2)/(1-x2) * average.
    function bezierSegment(prop, k, b) {
        var t0 = prop.keyTime(k), t1 = prop.keyTime(k + 1), dt = t1 - t0;
        if (dt <= 0) return;
        var v0 = prop.keyValue(k), v1 = prop.keyValue(k + 1);
        var spatial = prop.propertyValueType === PropertyValueType.TwoD_SPATIAL || prop.propertyValueType === PropertyValueType.ThreeD_SPATIAL;
        var deltas = [];
        if (v0 instanceof Array) {
            if (spatial) {
                var d2 = 0;
                for (var i = 0; i < v0.length; i++) d2 += (v1[i] - v0[i]) * (v1[i] - v0[i]);
                deltas.push(Math.sqrt(d2)); // spatial speed is along the path
            } else for (var j = 0; j < v0.length; j++) deltas.push(v1[j] - v0[j]);
        } else deltas.push(v1 - v0);
        var outInf = Math.max(0.1, Math.min(100, b[0] * 100)), inInf = Math.max(0.1, Math.min(100, (1 - b[2]) * 100));
        var outK = b[0] > 0 ? b[1] / b[0] : 0, inK = b[2] < 1 ? (1 - b[3]) / (1 - b[2]) : 0;
        var outs = [], ins = [];
        for (var d = 0; d < deltas.length; d++) {
            outs.push(new KeyframeEase(outK * deltas[d] / dt, outInf));
            ins.push(new KeyframeEase(inK * deltas[d] / dt, inInf));
        }
        prop.setInterpolationTypeAtKey(k, prop.keyInInterpolationType(k), KeyframeInterpolationType.BEZIER);
        prop.setInterpolationTypeAtKey(k + 1, KeyframeInterpolationType.BEZIER, prop.keyOutInterpolationType(k + 1));
        prop.setTemporalEaseAtKey(k, prop.keyInTemporalEase(k), outs);
        prop.setTemporalEaseAtKey(k + 1, ins, prop.keyOutTemporalEase(k + 1));
    }

    function setKeys(prop, keys, easing, opts) {
        opts = opts || {};
        if (!prop.canVaryOverTime) fail("Property '" + prop.name + "' cannot be animated");
        var idx = [];
        for (var i = 0; i < keys.length; i++) {
            var kf = keys[i];
            var k = prop.addKey(kf.time);
            prop.setValueAtKey(k, coerce(prop, kf.value));
            idx.push(kf.time);
        }
        // apply eases after all keys exist (indices shift as keys are added)
        for (i = 0; i < keys.length; i++) {
            var ki = prop.nearestKeyIndex(keys[i].time);
            applyEase(prop, ki, easing, keys[i]);
            if (has(keys[i], "roving") && prop.isSpatial) { try { prop.setRovingAtKey(ki, !!keys[i].roving); } catch (e) { } }
        }
        // bezier per segment (keyframe-level wins over the call default), then spatial tangents
        for (i = 0; i < keys.length; i++) {
            var kb = keys[i].bezier || opts.bezier;
            var ka = prop.nearestKeyIndex(keys[i].time);
            if (kb && ka < prop.numKeys) bezierSegment(prop, ka, kb);
            if ((keys[i].spatialIn || keys[i].spatialOut) && prop.isSpatial) {
                var dim = prop.keyValue(ka).length;
                // tangents must have the property's dimension (2D layers still have [x,y,z])
                var fit = function (v, fallback) { var o = []; for (var q = 0; q < dim; q++) o.push(v && q < v.length ? v[q] : (fallback ? fallback[q] : 0)); return o; };
                prop.setSpatialTangentsAtKey(ka, fit(keys[i].spatialIn, prop.keyInSpatialTangent(ka)), fit(keys[i].spatialOut, prop.keyOutSpatialTangent(ka)));
            }
        }
        if (opts.roving && prop.isSpatial) for (var r = 2; r < prop.numKeys; r++) { try { prop.setRovingAtKey(r, true); } catch (eR) { } }
        return prop.numKeys;
    }
    A.setKeys = setKeys;

    // --------------------------------------------------------------- handlers
    var H = {};
    A.handlers = H;

    // ---- Session / info
    H.ping = function () {
        return { ok: true, aeVersion: app.version, buildName: app.buildName, language: app.isoLanguage, runtime: A.version, project: app.project ? (app.project.file ? app.project.file.fsName : "(unsaved)") : null };
    };

    // Summary by default (counts + first 50 comps); detail:true lists every comp.
    // Never walks layers: only item-level properties are read.
    H.get_project_info = function (a) {
        a = a || {};
        var p = app.project;
        var counts = {}, comps = [], nComps = 0;
        var limit = a.detail ? 100000 : 50;
        for (var i = 1, n = p.numItems; i <= n; i++) {
            var it = p.item(i);
            var t = itemType(it);
            counts[t] = (counts[t] || 0) + 1;
            if (t === "composition") {
                nComps++;
                if (comps.length < limit) {
                    var o = { id: it.id, name: it.name, width: it.width, height: it.height, duration: round(it.duration), frameRate: round(it.frameRate, 3) };
                    if (a.detail) { o.numLayers = it.numLayers; o.folder = folderName(it.parentFolder); }
                    comps.push(o);
                }
            }
        }
        var active = p.activeItem instanceof CompItem ? { id: p.activeItem.id, name: p.activeItem.name } : null;
        var out = { name: p.file ? p.file.name : "(unsaved)", file: p.file ? p.file.fsName : null, dirty: p.dirty, numItems: p.numItems, counts: counts,
            compositionCount: nComps, compositions: comps, activeComp: active, bitsPerChannel: p.bitsPerChannel, renderQueueItems: p.renderQueue.numItems, aeVersion: app.version };
        if (!a.detail && nComps > comps.length) { out.compositionsTruncated = true; out.hint = "Showing " + comps.length + " of " + nComps + " compositions; pass detail:true or use list_compositions."; }
        try { out.workingSpace = p.workingSpace; } catch (e) { }
        try { out.expressionEngine = p.expressionEngine; } catch (e2) { }
        return out;
    };

    H.list_project_items = function (a) {
        var out = [];
        var items = allItems();
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            var t = itemType(it);
            if (a.type && a.type !== t && !(a.type === "footage" && t !== "composition" && t !== "folder")) continue;
            if (a.folder) { var f = it.parentFolder; var fp = folderName(f) || "/"; if (!f || (lower(fp) !== lower(String(a.folder).replace(/^\/+|\/+$/g, "") || "/") && lower(f.name) !== lower(a.folder) && String(f.id) !== String(a.folder))) continue; }
            if (a.query && lower(it.name).indexOf(lower(a.query)) < 0) continue;
            var o = { id: it.id, name: it.name, type: t, folder: folderName(it.parentFolder), label: it.label };
            if ((it instanceof CompItem || it instanceof FootageItem)) { o.width = it.width; o.height = it.height; o.duration = round(it.duration); o.frameRate = round(it.frameRate, 3); }
            if (it instanceof FootageItem && it.file) o.file = it.file.fsName;
            if (it instanceof FootageItem) { try { o.missing = it.footageMissing; } catch (e) { } }
            if (it instanceof CompItem) o.numLayers = it.numLayers;
            try { o.usedIn = it.usedIn ? it.usedIn.length : 0; } catch (e2) { }
            out.push(o);
        }
        var pg = page(out, a);
        return { count: pg.list.length, total: out.length, offset: pg.offset, truncated: pg.truncated, items: pg.list };
    };

    H.save_project = function (a) {
        if (a.path) {
            var f = outFile(a.path);
            if (f.exists && !a.overwrite) fail("File already exists: " + f.fsName, "Pass overwrite: true to replace it.");
            app.project.save(f);
        } else {
            if (!app.project.file) fail("Project has never been saved", "Pass 'path' (e.g. C:/Projects/my.aep).");
            app.project.save();
        }
        return { saved: true, file: app.project.file ? app.project.file.fsName : null };
    };

    H.open_project = function (a) {
        if (app.project && app.project.dirty && !a.discardChanges) fail("Current project has unsaved changes", "Save it first with save_project, or pass discardChanges: true.");
        var f = new File(a.path);
        if (!f.exists) fail("Project file not found: " + a.path);
        if (app.project) app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
        var p = app.open(f);
        return { opened: true, file: p.file.fsName, numItems: p.numItems };
    };

    H.new_project = function (a) {
        if (app.project && app.project.dirty && !a.discardChanges) fail("Current project has unsaved changes", "Save it first, or pass discardChanges: true.");
        if (app.project) app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
        app.newProject();
        return { created: true };
    };

    H.import_files = function (a) {
        var out = [], errors = [];
        var folder = null;
        if (a.folder) {
            folder = folderPath(a.folder, true);
        }
        for (var i = 0; i < a.paths.length; i++) {
            try {
                var f = new File(a.paths[i]);
                if (!f.exists) { errors.push({ path: a.paths[i], error: "File not found" }); continue; }
                var io = new ImportOptions(f);
                if (a.sequence) { if (io.canImportAs(ImportAsType.FOOTAGE)) io.importAs = ImportAsType.FOOTAGE; io.sequence = true; if (a.forceAlphabetical) io.forceAlphabetical = true; }
                if (a.importAs) {
                    var map = { footage: ImportAsType.FOOTAGE, composition: ImportAsType.COMP, comp_cropped_layers: ImportAsType.COMP_CROPPED_LAYERS, project: ImportAsType.PROJECT };
                    if (io.canImportAs(map[a.importAs])) io.importAs = map[a.importAs];
                }
                var item = app.project.importFile(io);
                if (folder) item.parentFolder = folder;
                var o = { id: item.id, name: item.name, type: itemType(item), folder: folderName(item.parentFolder) };
                if (a.addToComp) {
                    var comp = getComp(a.addToComp);
                    var l = comp.layers.add(item);
                    if (has(a, "startTime")) l.startTime = a.startTime;
                    o.layer = { index: l.index, id: l.id, name: l.name };
                }
                out.push(o);
            } catch (e) { errors.push({ path: a.paths[i], error: e.toString() }); }
        }
        return { imported: out, errors: errors };
    };

    H.create_folder = function (a) {
        var parent = a.parent ? folderPath(a.parent, true) : app.project.rootFolder;
        var f = folderPath((folderName(parent) ? folderName(parent) + "/" : "") + a.name, true);
        return { id: f.id, name: f.name, path: folderName(f) };
    };

    H.organize_items = function (a) {
        var moved = [];
        var folder = folderPath(a.folder, a.createFolder !== false);
        for (var i = 0; i < a.items.length; i++) {
            var it = findItem(a.items[i]);
            if (!it) fail("Item not found: " + a.items[i]);
            it.parentFolder = folder;
            moved.push(it.name);
        }
        return { folder: folderName(folder) || "/", moved: moved };
    };

    H.modify_item = function (a) {
        var it = findItem(a.item);
        if (!it) fail("Item not found: " + a.item);
        if (a["delete"]) { var nm = it.name; it.remove(); return { deleted: nm }; }
        if (has(a, "name")) it.name = a.name;
        if (has(a, "label")) it.label = a.label;
        if (has(a, "comment")) it.comment = a.comment;
        if (has(a, "replaceWithFile") && it instanceof FootageItem) it.replace(new File(a.replaceWithFile));
        if (has(a, "frameRate") && it instanceof FootageItem) it.mainSource.conformFrameRate = a.frameRate;
        if (has(a, "loop") && it instanceof FootageItem) it.mainSource.loop = a.loop;
        return { id: it.id, name: it.name, type: itemType(it) };
    };

    // ---- Compositions
    var COMP_PRESETS = {
        "hd": [1920, 1080], "1080p": [1920, 1080], "720p": [1280, 720], "4k": [3840, 2160], "uhd": [3840, 2160], "2k": [2048, 1080],
        "vertical": [1080, 1920], "story": [1080, 1920], "reels": [1080, 1920], "tiktok": [1080, 1920], "shorts": [1080, 1920],
        "square": [1080, 1080], "instagram": [1080, 1080], "portrait-4x5": [1080, 1350], "youtube-thumbnail": [1280, 720], "twitter": [1600, 900]
    };

    H.list_compositions = function () {
        var out = [];
        var items = allItems();
        for (var i = 0; i < items.length; i++) if (items[i] instanceof CompItem) out.push(compSummary(items[i]));
        return { count: out.length, compositions: out };
    };

    H.create_composition = function (a) {
        var w = a.width, h = a.height;
        if (a.preset) {
            var pr = COMP_PRESETS[lower(a.preset)];
            if (!pr) fail("Unknown preset '" + a.preset + "'");
            w = def(w, pr[0]); h = def(h, pr[1]);
        }
        w = def(w, 1920); h = def(h, 1080);
        var c = app.project.items.addComp(a.name, w, h, def(a.pixelAspect, 1), def(a.duration, 10), def(a.frameRate, 30));
        if (has(a, "backgroundColor")) c.bgColor = color(a.backgroundColor);
        if (a.folder) c.parentFolder = folderPath(a.folder, true);
        if (def(a.open, true)) { try { c.openInViewer(); } catch (e) { } }
        return compSummary(c);
    };

    H.get_composition = function (a) {
        var c = getComp(a.comp);
        var out = compSummary(c);
        out.layers = [];
        var maxL = Math.min(c.numLayers, def(a.layerLimit, 200));
        for (var i = 1; i <= maxL; i++) out.layers.push(shapeLayer(c.layer(i), a));
        if (maxL < c.numLayers) { out.layersTruncated = true; out.layersHint = "Showing " + maxL + " of " + c.numLayers + " layers; use list_layers with offset for the rest."; }
        out.motionBlur = c.motionBlur; out.shutterAngle = c.shutterAngle; out.renderer = c.renderer;
        try { out.markers = listMarkers(c.markerProperty); } catch (e) { }
        try { out.selectedLayers = []; for (var s = 0; s < c.selectedLayers.length; s++) out.selectedLayers.push(c.selectedLayers[s].index); } catch (e2) { }
        return out;
    };

    H.set_composition_settings = function (a) {
        var c = getComp(a.comp);
        if (has(a, "name")) c.name = a.name;
        if (has(a, "width")) c.width = a.width;
        if (has(a, "height")) c.height = a.height;
        if (has(a, "duration")) c.duration = a.duration;
        if (has(a, "frameRate")) c.frameRate = a.frameRate;
        if (has(a, "pixelAspect")) c.pixelAspect = a.pixelAspect;
        if (has(a, "backgroundColor")) c.bgColor = color(a.backgroundColor);
        if (has(a, "workAreaStart")) c.workAreaStart = a.workAreaStart;
        if (has(a, "workAreaDuration")) c.workAreaDuration = a.workAreaDuration;
        if (has(a, "motionBlur")) c.motionBlur = !!a.motionBlur;
        if (has(a, "shutterAngle")) c.shutterAngle = a.shutterAngle;
        if (has(a, "shutterPhase")) c.shutterPhase = a.shutterPhase;
        if (has(a, "currentTime")) c.time = a.currentTime;
        if (has(a, "renderer")) c.renderer = a.renderer;
        if (has(a, "hideShyLayers")) c.hideShyLayers = !!a.hideShyLayers;
        if (has(a, "resolutionFactor")) c.resolutionFactor = a.resolutionFactor;
        if (a.open) c.openInViewer();
        return compSummary(c);
    };

    H.duplicate_composition = function (a) {
        var c = getComp(a.comp);
        var d = c.duplicate();
        if (a.newName) d.name = a.newName;
        return compSummary(d);
    };

    H.open_composition = function (a) {
        var c = getComp(a.comp);
        c.openInViewer();
        if (has(a, "time")) c.time = a.time;
        return compSummary(c);
    };

    H.precompose_layers = function (a) {
        var c = getComp(a.comp);
        var layers = getLayers(c, a.layers);
        var idx = [];
        for (var i = 0; i < layers.length; i++) idx.push(layers[i].index);
        idx.sort(function (x, y) { return x - y; });
        var moveAll = def(a.moveAllAttributes, true);
        if (!moveAll && idx.length > 1) fail("moveAllAttributes:false only works with a single layer");
        var nc = c.layers.precompose(idx, a.name || "Pre-comp", moveAll);
        return { precomp: compSummary(nc), layerInParent: layerSummary(c.layer(idx[0])) };
    };

    // ---- Layers
    function placeLayer(comp, l, a) {
        if (has(a, "name")) l.name = a.name;
        if (has(a, "startTime")) l.startTime = a.startTime;
        if (has(a, "inPoint")) l.inPoint = a.inPoint;
        if (has(a, "duration")) l.outPoint = l.inPoint + a.duration;
        if (has(a, "outPoint")) l.outPoint = a.outPoint;
        // AE gives new layers the comp duration counted from their start: clamp to the comp end
        if (l.outPoint > comp.duration + 1e-6 && l.inPoint < comp.duration) l.outPoint = comp.duration;
        var tg = l.property("ADBE Transform Group");
        if (has(a, "threeD") && l instanceof AVLayer) l.threeDLayer = !!a.threeD;
        if (has(a, "anchor")) setAnchor(l, a.anchor);
        if (has(a, "position")) { var pp = tg.property("ADBE Position"); pp.setValue(coerce(pp, a.position)); }
        if (has(a, "anchorPoint")) { var ap = tg.property("ADBE Anchor Point"); ap.setValue(coerce(ap, a.anchorPoint)); }
        if (has(a, "scale")) { var sp = tg.property("ADBE Scale"); sp.setValue(coerce(sp, typeof a.scale === "number" ? [a.scale, a.scale, a.scale] : a.scale)); }
        if (has(a, "rotation")) tg.property("ADBE Rotate Z").setValue(a.rotation);
        if (has(a, "opacity")) tg.property("ADBE Opacity").setValue(a.opacity);
        if (has(a, "blendMode") && l instanceof AVLayer) l.blendingMode = blendValue(a.blendMode);
        if (has(a, "label")) l.label = a.label;
        if (has(a, "parent")) l.parent = a.parent === "" || a.parent === null ? null : getLayer(comp, a.parent);
    }

    // Anchor point on the layer's visible content (sourceRectAtTime). "origin" = [0,0];
    // "baseline-*" = on the text baseline (y = 0 in a text layer). The Position is
    // compensated (scale and Z rotation) so the layer does not move on screen.
    var ANCHORS = { "center": [0.5, 0.5], "left": [0, 0.5], "right": [1, 0.5], "top": [0.5, 0], "bottom": [0.5, 1],
        "top-left": [0, 0], "top-right": [1, 0], "bottom-left": [0, 1], "bottom-right": [1, 1] };
    function anchorTarget(l, where) {
        if (where === "origin") return [0, 0];
        var r = l.sourceRectAtTime(l.containingComp.time, false);
        // string ops, not a regex: ExtendScript mis-captures alternations like (left|center|right)
        if (where.indexOf("baseline-") === 0) {
            if (!(l instanceof TextLayer)) fail("Anchor '" + where + "' only applies to text layers");
            var side = where.substr(9);
            var k = -1;
            if (side === "left") k = 0; else if (side === "right") k = 1; else if (side === "center") k = 0.5;
            if (k < 0) fail("Unknown anchor '" + where + "'");
            return [r.left + r.width * k, 0];
        }
        var f = ANCHORS[where];
        if (!f) fail("Unknown anchor '" + where + "'", "Use center, left, right, top, bottom, top-left, top-right, bottom-left, bottom-right, baseline-left, baseline-center, baseline-right or origin.");
        return [r.left + r.width * f[0], r.top + r.height * f[1]];
    }
    function setAnchor(l, where) {
        var tg = l.property("ADBE Transform Group");
        var ap = tg.property("ADBE Anchor Point");
        if (ap.numKeys > 0) fail("Anchor Point of '" + l.name + "' is animated; remove its keyframes first");
        var cur = ap.value, nxt = anchorTarget(l, where);
        var dx = nxt[0] - cur[0], dy = nxt[1] - cur[1];
        if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return;
        ap.setValue(cur.length === 3 ? [nxt[0], nxt[1], cur[2]] : [nxt[0], nxt[1]]);
        var pos = tg.property("ADBE Position");
        if (pos.numKeys > 0 || pos.dimensionsSeparated) return; // animated position: keep keys, the layer shifts
        var sc = tg.property("ADBE Scale").value, rot = tg.property("ADBE Rotate Z").value * Math.PI / 180;
        var sx = dx * sc[0] / 100, sy = dy * sc[1] / 100;
        var pv = pos.value;
        pv[0] += sx * Math.cos(rot) - sy * Math.sin(rot);
        pv[1] += sx * Math.sin(rot) + sy * Math.cos(rot);
        pos.setValue(pv);
    }
    function centerAnchor(l) { try { setAnchor(l, "center"); } catch (e) { } }
    A.anchorTarget = anchorTarget;

    H.create_text_layer = function (a) {
        var c = getComp(a.comp);
        var l;
        if (a.boxSize) l = c.layers.addBoxText(a.boxSize, String(a.text));
        else l = c.layers.addText(String(a.text));
        var p = l.property("ADBE Text Properties").property("ADBE Text Document");
        var td = p.value;
        // A new text layer copies AE's Character panel (last used font, ALL CAPS, faux styles...).
        // Set every style explicitly so the result does not depend on the machine's UI state.
        var style = { font: def(a.font, "ArialMT"), fontSize: def(a.fontSize, 72), fillColor: def(a.color, "#ffffff"), applyFill: true,
            tracking: def(a.tracking, 0), baselineShift: 0, justification: def(a.justification, "center"),
            caps: def(a.caps, has(a, "allCaps") ? (a.allCaps ? "all" : "normal") : "normal"),
            fauxBold: !!a.fauxBold, fauxItalic: !!a.fauxItalic };
        if (has(a, "leading")) style.leading = a.leading; else td.autoLeading = true;
        if (has(a, "strokeColor")) { style.strokeColor = a.strokeColor; style.strokeWidth = def(a.strokeWidth, 2); }
        else if (has(a, "strokeWidth")) style.strokeWidth = a.strokeWidth;
        else td.applyStroke = false;
        try { applyTextStyle(td, style); } catch (e) {
            if (style.font) { delete style.font; applyTextStyle(td, style); } else throw e;
        }
        p.setValue(td);
        if (!has(a, "anchor")) {
            var j = lower(def(a.justification, "center"));
            if (a.centerAnchor === false) a.anchor = "origin";
            else if (j === "left") a.anchor = "baseline-left";
            else if (j === "right") a.anchor = "baseline-right";
            else a.anchor = "center";
        }
        if (!has(a, "position")) a.position = [c.width / 2, c.height / 2];
        placeLayer(c, l, a);
        var res = summary(l);
        res.anchor = a.anchor;
        res.appliedFont = p.value.font;
        var glyphWarn = glyphWarning(l, a.text, p.value.font);
        if (glyphWarn) res.warning = (res.warning ? res.warning + " " : "") + glyphWarn;
        res.caps = capsName(p.value);
        if (has(a, "font") && !fontExists(a.font)) res.warning = "Font '" + a.font + "' is not installed (AE shows it as missing). Use list_fonts to find an installed PostScript name.";
        return res;
    };

    // A font without glyphs for the text renders nothing: the text box has no width.
    function glyphWarning(l, text, font) {
        try {
            if (!/\S/.test(String(text))) return null;
            var r = l.sourceRectAtTime(l.containingComp.time, false);
            if (r.width < 0.5) return "Font '" + font + "' renders nothing for this text (missing glyphs?). Pick a font that covers these characters (list_fonts).";
        } catch (e) { }
        return null;
    }

    function fontExists(name) {
        try {
            if (app.fonts && typeof app.fonts.getFontsByPostScriptName === "function") {
                // AE returns a substitute font object for missing fonts: only real ones count
                var list = app.fonts.getFontsByPostScriptName(name);
                for (var i = 0; i < list.length; i++) if (!list[i].isSubstitute) return true;
                return false;
            }
        } catch (e) { }
        return true; // cannot check on AE < 2024
    }

    H.set_text = function (a) {
        var t = target(a);
        if (!(t.layer instanceof TextLayer)) fail("Layer '" + t.layer.name + "' is not a text layer");
        var p = t.layer.property("ADBE Text Properties").property("ADBE Text Document");
        var td = p.value;
        applyTextStyle(td, a);
        if (has(a, "time") && p.numKeys > 0) p.setValueAtTime(a.time, td);
        else if (has(a, "time")) p.setValueAtTime(a.time, td);
        else if (p.numKeys > 0) p.setValueAtTime(t.comp.time, td);
        else p.setValue(td);
        var out = { layer: t.layer.name, text: serText(p.value) };
        var gw = glyphWarning(t.layer, p.value.text, p.value.font);
        if (gw) out.warning = gw;
        if (has(a, "font") && !fontExists(a.font)) out.warning = "Font '" + a.font + "' is not installed. Use list_fonts.";
        return out;
    };

    // Ready-to-use property paths of one shape group (re-resolved by match name: AE
    // invalidates property objects when siblings are added).
    function shapePaths(grp) {
        var o = { group: propPath(grp) };
        var vecs = grp.property("ADBE Vectors Group");
        function first(mn) { for (var i = 1; i <= vecs.numProperties; i++) if (vecs.property(i).matchName === mn) return vecs.property(i); return null; }
        var rect = first("ADBE Vector Shape - Rect"), ell = first("ADBE Vector Shape - Ellipse"), star = first("ADBE Vector Shape - Star"), path = first("ADBE Vector Shape - Group");
        if (rect) { o.size = propPath(rect.property("ADBE Vector Rect Size")); o.roundness = propPath(rect.property("ADBE Vector Rect Roundness")); }
        if (ell) o.size = propPath(ell.property("ADBE Vector Ellipse Size"));
        if (star) { o.points = propPath(star.property("ADBE Vector Star Points")); o.outerRadius = propPath(star.property("ADBE Vector Star Outer Radius")); }
        if (path) o.path = propPath(path.property("ADBE Vector Shape"));
        var fill = first("ADBE Vector Graphic - Fill");
        if (fill) { o.fillColor = propPath(fill.property("ADBE Vector Fill Color")); o.fillOpacity = propPath(fill.property("ADBE Vector Fill Opacity")); }
        var stroke = first("ADBE Vector Graphic - Stroke");
        if (stroke) { o.strokeColor = propPath(stroke.property("ADBE Vector Stroke Color")); o.strokeWidth = propPath(stroke.property("ADBE Vector Stroke Width")); }
        var trim = first("ADBE Vector Filter - Trim");
        if (trim) { o.trimStart = propPath(trim.property("ADBE Vector Trim Start")); o.trimEnd = propPath(trim.property("ADBE Vector Trim End")); o.trimOffset = propPath(trim.property("ADBE Vector Trim Offset")); }
        var rep = first("ADBE Vector Filter - Repeater");
        if (rep) o.repeaterCopies = propPath(rep.property("ADBE Vector Repeater Copies"));
        var tr = grp.property("ADBE Vector Transform Group");
        o.position = propPath(tr.property("ADBE Vector Position"));
        o.scale = propPath(tr.property("ADBE Vector Scale"));
        o.rotation = propPath(tr.property("ADBE Vector Rotation"));
        return o;
    }

    function addShapeGroup(contents, s, comp, ctx) {
        var grp = contents.addProperty("ADBE Vector Group");
        if (s.name) grp.name = s.name;
        var vecs = grp.property("ADBE Vectors Group");
        var type = lower(def(s.type, "rectangle"));
        var size = def(s.size, [200, 200]);
        if (typeof size === "number") size = [size, size];
        var shp;
        if (type === "rectangle" || type === "rect") {
            shp = vecs.addProperty("ADBE Vector Shape - Rect");
            shp.property("ADBE Vector Rect Size").setValue(size);
            if (has(s, "roundness")) shp.property("ADBE Vector Rect Roundness").setValue(s.roundness);
        } else if (type === "ellipse" || type === "circle") {
            shp = vecs.addProperty("ADBE Vector Shape - Ellipse");
            shp.property("ADBE Vector Ellipse Size").setValue(size);
        } else if (type === "polygon" || type === "star") {
            shp = vecs.addProperty("ADBE Vector Shape - Star");
            shp.property("ADBE Vector Star Type").setValue(type === "star" ? 1 : 2);
            shp.property("ADBE Vector Star Points").setValue(def(s.points, type === "star" ? 5 : 6));
            var outer = def(s.outerRadius, size[0] / 2);
            shp.property("ADBE Vector Star Outer Radius").setValue(outer);
            if (type === "star") shp.property("ADBE Vector Star Inner Radius").setValue(def(s.innerRadius, outer / 2));
            if (has(s, "roundness")) shp.property("ADBE Vector Star Outer Roundess").setValue(s.roundness);
        } else if (type === "path") {
            if (!s.vertices) fail("Shape type 'path' needs 'vertices'");
            shp = vecs.addProperty("ADBE Vector Shape - Group");
            shp.property("ADBE Vector Shape").setValue(toShape({ vertices: s.vertices, inTangents: s.inTangents, outTangents: s.outTangents, closed: def(s.closed, true) }));
        } else fail("Unknown shape type '" + type + "'", "Use rectangle, ellipse, polygon, star or path.");
        if (s.gradient && s.gradient.colors && s.gradient.colors.length >= 2) {
            // AE exposes no scripting API for gradient stops ("ADBE Vector Grad Colors" is
            // NO_VALUE and takes no expression). A solid fill keeps the shape's alpha and a
            // layer-level Gradient Ramp paints it; see create_shape_layer.
            var stops = s.gradient.colors;
            var solid = vecs.addProperty("ADBE Vector Graphic - Fill");
            solid.property("ADBE Vector Fill Color").setValue(color(stops[0].color, true));
            var off = s.offset || [0, 0];
            var half = (size[0] || 200) / 2;
            var isRadial = lower(def(s.gradient.type, "linear")) === "radial";
            var st = s.gradient.start ? [s.gradient.start[0] + off[0], s.gradient.start[1] + off[1]] : (isRadial ? [off[0], off[1]] : [off[0] - half, off[1]]);
            var en = s.gradient.end ? [s.gradient.end[0] + off[0], s.gradient.end[1] + off[1]] : [off[0] + half, off[1]];
            if (ctx) ctx.ramps.push({ start: st, end: en, from: stops[0].color, to: stops[stops.length - 1].color, radial: isRadial, stops: stops.length });
        } else if (s.gradient) {
            var gf = vecs.addProperty("ADBE Vector Graphic - G-Fill");
            gf.property("ADBE Vector Grad Type").setValue(lower(def(s.gradient.type, "linear")) === "radial" ? 2 : 1);
            if (s.gradient.start) gf.property("ADBE Vector Grad Start Pt").setValue(s.gradient.start);
            if (s.gradient.end) gf.property("ADBE Vector Grad End Pt").setValue(s.gradient.end);
            // Gradient colors are not scriptable directly; set via expression-free approach is unsupported, so expose a note.
        } else if (s.fill !== null && s.fill !== false) {
            var fill = vecs.addProperty("ADBE Vector Graphic - Fill");
            fill.property("ADBE Vector Fill Color").setValue(color(def(s.fill, "#ffffff"), true));
            if (has(s, "fillOpacity")) fill.property("ADBE Vector Fill Opacity").setValue(s.fillOpacity);
        }
        if (s.stroke) {
            var st = vecs.addProperty("ADBE Vector Graphic - Stroke");
            st.property("ADBE Vector Stroke Color").setValue(color(s.stroke, true));
            st.property("ADBE Vector Stroke Width").setValue(def(s.strokeWidth, 4));
            if (has(s, "strokeOpacity")) st.property("ADBE Vector Stroke Opacity").setValue(s.strokeOpacity);
            if (s.lineCap) st.property("ADBE Vector Stroke Line Cap").setValue({ butt: 1, round: 2, projecting: 3 }[s.lineCap] || 1);
        }
        if (s.trimPaths) {
            var tp = vecs.addProperty("ADBE Vector Filter - Trim");
            if (has(s.trimPaths, "start")) tp.property("ADBE Vector Trim Start").setValue(s.trimPaths.start);
            if (has(s.trimPaths, "end")) tp.property("ADBE Vector Trim End").setValue(s.trimPaths.end);
            if (has(s.trimPaths, "offset")) tp.property("ADBE Vector Trim Offset").setValue(s.trimPaths.offset);
        }
        if (s.repeater) {
            var rp = vecs.addProperty("ADBE Vector Filter - Repeater");
            rp.property("ADBE Vector Repeater Copies").setValue(def(s.repeater.copies, 3));
            if (s.repeater.offsetPosition) rp.property("ADBE Vector Repeater Transform").property("ADBE Vector Repeater Position").setValue(s.repeater.offsetPosition);
            if (has(s.repeater, "offsetRotation")) rp.property("ADBE Vector Repeater Transform").property("ADBE Vector Repeater Rotation").setValue(s.repeater.offsetRotation);
        }
        if (s.offset) grp.property("ADBE Vector Transform Group").property("ADBE Vector Position").setValue(s.offset);
        if (has(s, "rotation")) grp.property("ADBE Vector Transform Group").property("ADBE Vector Rotation").setValue(s.rotation);
        if (ctx && !A._lean) ctx.paths.push(shapePaths(grp)); // costs property reads: skipped in lean batches
        return grp;
    }

    H.create_shape_layer = function (a) {
        var c = getComp(a.comp);
        var l = c.layers.addShape();
        var contents = l.property("ADBE Root Vectors Group");
        var shapes = a.shapes;
        if (!shapes || !shapes.length) {
            // top-level fields describe a single shape; layer-level name/rotation/position are not group props
            var one = {};
            for (var key in a) if (a.hasOwnProperty(key) && key !== "name" && key !== "rotation" && key !== "position" && key !== "comp") one[key] = a[key];
            shapes = [one];
        }
        var ctx = { ramps: [], paths: [] };
        for (var i = 0; i < shapes.length; i++) addShapeGroup(contents, shapes[i], c, ctx);
        var warnings = [];
        if (ctx.ramps.length) {
            var rp = ctx.ramps[0];
            var ramp = l.property("ADBE Effect Parade").addProperty("ADBE Ramp");
            ramp.name = "Gradient";
            // effect points live in the layer's box (comp-sized for shape layers, origin at its
            // top-left), while shape contents are centered on that box: shift by half its size
            var hw = (l.width || c.width) / 2, hh = (l.height || c.height) / 2;
            rp.start = [rp.start[0] + hw, rp.start[1] + hh];
            rp.end = [rp.end[0] + hw, rp.end[1] + hh];
            ramp.property("ADBE Ramp-0001").setValue(rp.start);
            ramp.property("ADBE Ramp-0002").setValue(color(rp.from));
            ramp.property("ADBE Ramp-0003").setValue(rp.end);
            ramp.property("ADBE Ramp-0004").setValue(color(rp.to));
            ramp.property("ADBE Ramp-0005").setValue(rp.radial ? 2 : 1);
            if (rp.stops > 2) warnings.push("Only the first and last gradient colors are used: After Effects has no scripting API for gradient stops, so a Gradient Ramp effect paints the shape.");
            if (ctx.ramps.length > 1) warnings.push("Gradient Ramp is a layer effect: with several gradient shapes in one layer only the first gradient is used. Put each gradient shape in its own layer.");
        }
        l.name = def(a.name, "Shape " + (shapes[0].type || "rectangle"));
        if (!has(a, "position")) a.position = [c.width / 2, c.height / 2];
        placeLayer(c, l, a);
        var res = summary(l);
        // paths of every shape, ready for set_property / set_keyframes (e.g. paths.trimEnd)
        if (!A._lean) res.shapes = ctx.paths;
        if (warnings.length) res.warning = warnings.join(" ");
        return res;
    };

    H.create_solid_layer = function (a) {
        var c = getComp(a.comp);
        var col = color(def(a.color, a.adjustment ? "#ffffff" : "#000000"));
        var l = c.layers.addSolid(col, def(a.name, a.adjustment ? "Adjustment Layer" : "Solid"), def(a.width, c.width), def(a.height, c.height), c.pixelAspect, c.duration);
        if (a.adjustment) l.adjustmentLayer = true;
        placeLayer(c, l, a);
        return summary(l);
    };

    H.create_null_layer = function (a) {
        var c = getComp(a.comp);
        var l = c.layers.addNull(c.duration);
        if (!has(a, "name")) a.name = "Null";
        placeLayer(c, l, a);
        if (a.childLayers) { var ch = getLayers(c, a.childLayers); for (var i = 0; i < ch.length; i++) ch[i].parent = l; }
        return summary(l);
    };

    H.create_camera = function (a) {
        var c = getComp(a.comp);
        var poi = def(a.pointOfInterest, [c.width / 2, c.height / 2, 0]);
        var l = c.layers.addCamera(def(a.name, "Camera"), [poi[0], poi[1]]);
        var tg = l.property("ADBE Transform Group");
        var co = l.property("ADBE Camera Options Group");
        if (has(a, "zoom")) co.property("ADBE Camera Zoom").setValue(a.zoom);
        if (has(a, "focalLength")) co.property("ADBE Camera Zoom").setValue(c.width * a.focalLength / 36); // 36 mm film width
        var zoom = co.property("ADBE Camera Zoom").value;
        // Default: straight in front of the point of interest at the zoom distance, so the
        // comp looks exactly as without a camera ([w/2, h/2, -zoom]); AE's own default put it
        // at [0,0,...], which made any Position keyframe written from it inconsistent.
        tg.property("ADBE Anchor Point").setValue(poi.length === 3 ? poi : [poi[0], poi[1], 0]);
        tg.property("ADBE Position").setValue(has(a, "position") ? a.position : [poi[0], poi[1], -zoom]);
        if (has(a, "depthOfField")) co.property("ADBE Camera Depth of Field").setValue(a.depthOfField ? 1 : 0);
        if (has(a, "focusDistance")) co.property("ADBE Camera Focus Distance").setValue(a.focusDistance);
        else co.property("ADBE Camera Focus Distance").setValue(zoom);
        if (has(a, "aperture")) co.property("ADBE Camera Aperture").setValue(a.aperture);
        if (has(a, "blurLevel")) co.property("ADBE Camera Blur Level").setValue(a.blurLevel);
        if (a.oneNode) { try { l.autoOrient = AutoOrientType.NO_AUTO_ORIENT; } catch (e) { } }
        var res = summary(l);
        res.camera = { position: serValue(tg.property("ADBE Position").value), pointOfInterest: serValue(tg.property("ADBE Anchor Point").value), zoom: round(zoom), focusDistance: round(co.property("ADBE Camera Focus Distance").value) };
        return res;
    };

    H.create_light = function (a) {
        var c = getComp(a.comp);
        var l = c.layers.addLight(def(a.name, "Light"), [c.width / 2, c.height / 2]);
        var types = { parallel: LightType.PARALLEL, spot: LightType.SPOT, point: LightType.POINT, ambient: LightType.AMBIENT };
        l.lightType = types[lower(def(a.lightType, "point"))];
        var lo = l.property("ADBE Light Options Group");
        if (has(a, "color")) lo.property("ADBE Light Color").setValue(color(a.color));
        if (has(a, "intensity")) lo.property("ADBE Light Intensity").setValue(a.intensity);
        if (has(a, "coneAngle")) try { lo.property("ADBE Light Cone Angle").setValue(a.coneAngle); } catch (e) { }
        if (has(a, "coneFeather")) try { lo.property("ADBE Light Cone Feather 2").setValue(a.coneFeather); } catch (e2) { }
        if (has(a, "castsShadows")) try { lo.property("ADBE Light Casts Shadows").setValue(a.castsShadows ? 1 : 0); } catch (e3) { }
        if (has(a, "position")) l.property("ADBE Transform Group").property("ADBE Position").setValue(a.position);
        if (has(a, "pointOfInterest")) try { l.property("ADBE Transform Group").property("ADBE Anchor Point").setValue(a.pointOfInterest); } catch (e4) { }
        return summary(l);
    };

    H.add_item_to_comp = function (a) {
        var c = getComp(a.comp);
        var it = findItem(a.item);
        if (!it || !((it instanceof CompItem || it instanceof FootageItem))) fail("AV item not found: " + a.item, "Use list_project_items to find footage/comp ids.");
        if (it === c) fail("Cannot add a composition to itself");
        var l = c.layers.add(it);
        placeLayer(c, l, a);
        if (a.fitToComp) {
            var s = Math.min(c.width / it.width, c.height / it.height) * 100;
            if (a.fitToComp === "fill") s = Math.max(c.width / it.width, c.height / it.height) * 100;
            l.property("ADBE Transform Group").property("ADBE Scale").setValue([s, s]);
            l.property("ADBE Transform Group").property("ADBE Position").setValue([c.width / 2, c.height / 2]);
        }
        return summary(l);
    };

    H.list_layers = function (a) {
        var c = getComp(a.comp);
        var out = [], matched = [];
        for (var i = 1; i <= c.numLayers; i++) {
            var l = c.layer(i);
            if (a.type && layerType(l) !== a.type) continue;
            if (a.query && lower(l.name).indexOf(lower(a.query)) < 0) continue;
            matched.push(l);
        }
        // summarise only the requested page: layerSummary is the expensive part on big comps
        var pg = page(matched, a);
        for (var j = 0; j < pg.list.length; j++) out.push(shapeLayer(pg.list[j], a));
        return { comp: c.name, count: out.length, total: matched.length, offset: pg.offset, truncated: pg.truncated, layers: out };
    };

    H.get_layer_details = function (a) {
        var t = target(a);
        var out = layerSummary(t.layer);
        out.properties = dumpProps(t.layer, 1, def(a.depth, 3), def(a.includeKeyframes, true), !!a.onlyAnimated);
        try { out.markers = listMarkers(t.layer.property("ADBE Marker")); } catch (e) { }
        try { var r = t.layer.sourceRectAtTime(t.comp.time, false); out.sourceRect = { left: round(r.left), top: round(r.top), width: round(r.width), height: round(r.height) }; } catch (e2) { }
        return out;
    };

    H.set_layer_properties = function (a) {
        var c = getComp(a.comp);
        var layers = getLayers(c, has(a, "layers") ? a.layers : a.layer);
        var out = [];
        for (var i = 0; i < layers.length; i++) {
            var l = layers[i];
            placeLayer(c, l, a);
            if (has(a, "enabled")) l.enabled = !!a.enabled;
            if (has(a, "locked")) l.locked = !!a.locked;
            if (has(a, "shy")) l.shy = !!a.shy;
            if (has(a, "solo")) l.solo = !!a.solo;
            if (l instanceof AVLayer) {
                if (has(a, "motionBlur")) l.motionBlur = !!a.motionBlur;
                if (has(a, "adjustmentLayer")) l.adjustmentLayer = !!a.adjustmentLayer;
                if (has(a, "collapseTransformation")) l.collapseTransformation = !!a.collapseTransformation;
                if (has(a, "quality")) l.quality = { best: LayerQuality.BEST, draft: LayerQuality.DRAFT, wireframe: LayerQuality.WIREFRAME }[a.quality];
                if (has(a, "audioEnabled")) l.audioEnabled = !!a.audioEnabled;
                if (has(a, "timeRemapEnabled") && l.canSetTimeRemapEnabled) l.timeRemapEnabled = !!a.timeRemapEnabled;
                if (has(a, "stretch")) l.stretch = a.stretch;
            }
            if (has(a, "autoOrient")) l.autoOrient = a.autoOrient ? AutoOrientType.ALONG_PATH : AutoOrientType.NO_AUTO_ORIENT;
            if (has(a, "audioLevels") || a.audioFade) setAudio(l, a);
            if (has(a, "centerAnchor") && !has(a, "anchor")) setAnchor(l, a.centerAnchor ? "center" : "origin");
            if (has(a, "newName") ) l.name = a.newName;
            out.push(layerSummary(l));
        }
        return { updated: out.length, layers: out };
    };

    H.duplicate_layer = function (a) {
        var t = target(a);
        var out = [];
        var n = def(a.count, 1);
        var src = t.layer;
        for (var i = 0; i < n; i++) {
            var d = src.duplicate();
            if (a.newName) d.name = n > 1 ? a.newName + " " + (i + 1) : a.newName;
            if (a.offset) {
                var p = d.property("ADBE Transform Group").property("ADBE Position");
                if (p.numKeys === 0) { var v = p.value; v[0] += a.offset[0] * (i + 1); v[1] += a.offset[1] * (i + 1); p.setValue(v); }
            }
            if (a.timeOffset) d.startTime = src.startTime + a.timeOffset * (i + 1);
            out.push(layerSummary(d));
        }
        return { duplicates: out };
    };

    H.delete_layers = function (a) {
        var c = getComp(a.comp);
        var layers = getLayers(c, a.layers);
        var names = [], sources = [], removedSources = 0;
        for (var i = 0; i < layers.length; i++) {
            var l = layers[i];
            // nulls and solids each own a footage item in the Solids folder
            if (a.removeSources && l instanceof AVLayer && l.source instanceof FootageItem && l.source.mainSource instanceof SolidSource) sources.push(l.source);
            names.push(l.name);
            if (l.locked) l.locked = false;
            l.remove();
        }
        for (var j = 0; j < sources.length; j++) {
            try { if (sources[j].usedIn.length === 0) { sources[j].remove(); removedSources++; } } catch (e) { /* already removed (shared source) */ }
        }
        var out = { deleted: names };
        if (a.removeSources) out.removedSources = removedSources;
        return out;
    };

    // Remove footage that no layer uses. type:"solid" limits it to solid/null sources;
    // keep: ids that must never be removed (e.g. what existed before a test).
    H.remove_unused_footage = function (a) {
        var keep = {};
        if (a.keep) for (var k = 0; k < a.keep.length; k++) keep[a.keep[k]] = true;
        var type = def(a.type, "all");
        var before = app.project.numItems;
        if (type === "all" && !a.keep) {
            var n = app.project.removeUnusedFootage();
            return { removed: typeof n === "number" ? n : before - app.project.numItems, type: type };
        }
        var removed = 0, folders = [];
        for (var i = app.project.numItems; i >= 1; i--) {
            var it = app.project.item(i);
            if (!(it instanceof FootageItem) || keep[it.id]) continue;
            if (type === "solid" && !(it.mainSource instanceof SolidSource)) continue;
            if (it.usedIn.length) continue;
            var parent = it.parentFolder;
            it.remove();
            removed++;
            if (parent && parent !== app.project.rootFolder) folders.push(parent);
        }
        var removedFolders = 0;
        if (a.removeEmptyFolders !== false) {
            for (var f = 0; f < folders.length; f++) {
                try { if (folders[f].numItems === 0 && !keep[folders[f].id]) { folders[f].remove(); removedFolders++; } } catch (e) { /* removed already */ }
            }
        }
        return { removed: removed, removedFolders: removedFolders, type: type };
    };

    H.reorder_layer = function (a) {
        var t = target(a);
        var l = t.layer;
        var pos = lower(a.position);
        if (pos === "top") l.moveToBeginning();
        else if (pos === "bottom") l.moveToEnd();
        else if (pos === "before") l.moveBefore(getLayer(t.comp, a.relativeTo));
        else if (pos === "after") l.moveAfter(getLayer(t.comp, a.relativeTo));
        else if (pos === "index") { var dst = getLayer(t.comp, a.index); if (dst !== l) { if (dst.index < l.index) l.moveBefore(dst); else l.moveAfter(dst); } }
        else fail("Unknown position '" + a.position + "'");
        return summary(l);
    };

    H.set_parent = function (a) {
        var c = getComp(a.comp);
        var children = getLayers(c, a.layers);
        var parent = (a.parent === null || a.parent === "" || a.parent === undefined) ? null : getLayer(c, a.parent);
        var out = [];
        for (var i = 0; i < children.length; i++) {
            if (children[i] === parent) fail("A layer cannot be its own parent");
            children[i].parent = parent;
            out.push(children[i].name);
        }
        return { parent: parent ? parent.name : null, children: out };
    };

    var MATTES = { "alpha": "ALPHA", "alpha-inverted": "ALPHA_INVERTED", "luma": "LUMA", "luma-inverted": "LUMA_INVERTED", "none": "NO_TRACK_MATTE" };
    H.set_track_matte = function (a) {
        var t = target(a);
        var l = t.layer;
        var type = TrackMatteType[MATTES[lower(def(a.type, "alpha"))]];
        if (type === undefined) fail("Unknown matte type '" + a.type + "'");
        if (typeof l.setTrackMatte === "function") {
            // AE 2023+: any layer can be the matte
            if (type === TrackMatteType.NO_TRACK_MATTE) l.removeTrackMatte();
            else l.setTrackMatte(a.matteLayer !== undefined ? getLayer(t.comp, a.matteLayer) : t.comp.layer(l.index - 1), type);
        } else {
            if (a.matteLayer !== undefined) { var m = getLayer(t.comp, a.matteLayer); m.moveBefore(l); }
            l.trackMatteType = type;
        }
        return summary(l);
    };

    H.split_layer = function (a) {
        var t = target(a);
        var l = t.layer;
        var at = def(a.time, t.comp.time);
        if (at <= l.inPoint || at >= l.outPoint) fail("Split time " + at + " is outside the layer (" + round(l.inPoint) + "-" + round(l.outPoint) + ")");
        var d = l.duplicate();
        l.outPoint = at;
        d.inPoint = at;
        return { first: layerSummary(l), second: layerSummary(d) };
    };

    H.sequence_layers = function (a) {
        var c = getComp(a.comp);
        var layers = getLayers(c, a.layers);
        if (a.order === "reverse") layers.reverse();
        var t = def(a.startTime, layers.length ? layers[0].inPoint : 0);
        var overlap = def(a.overlap, 0);
        var out = [];
        for (var i = 0; i < layers.length; i++) {
            var l = layers[i];
            if (has(a, "stagger")) {
                l.startTime = def(a.startTime, 0) + a.stagger * i - (l.inPoint - l.startTime);
            } else {
                var len = l.outPoint - l.inPoint;
                l.startTime = t - (l.inPoint - l.startTime);
                t = l.outPoint - overlap;
            }
            out.push({ name: l.name, inPoint: round(l.inPoint), outPoint: round(l.outPoint) });
        }
        return { sequenced: out };
    };

    H.align_layers = function (a) {
        var c = getComp(a.comp);
        var layers = getLayers(c, a.layers);
        var out = [];
        for (var i = 0; i < layers.length; i++) {
            var l = layers[i];
            var tg = l.property("ADBE Transform Group");
            var pos = tg.property("ADBE Position");
            if (pos.numKeys > 0 || pos.dimensionsSeparated) continue;
            var r = l.sourceRectAtTime(c.time, false);
            var s = tg.property("ADBE Scale").value;
            var ap = tg.property("ADBE Anchor Point").value;
            var w = r.width * Math.abs(s[0]) / 100, h = r.height * Math.abs(s[1]) / 100;
            var leftOff = (r.left - ap[0]) * s[0] / 100, topOff = (r.top - ap[1]) * s[1] / 100;
            var v = pos.value;
            var m = def(a.margin, 0);
            var hA = lower(def(a.horizontal, "none")), vA = lower(def(a.vertical, "none"));
            if (hA === "left") v[0] = m - leftOff;
            else if (hA === "center") v[0] = c.width / 2 - leftOff - w / 2;
            else if (hA === "right") v[0] = c.width - m - leftOff - w;
            if (vA === "top") v[1] = m - topOff;
            else if (vA === "center") v[1] = c.height / 2 - topOff - h / 2;
            else if (vA === "bottom") v[1] = c.height - m - topOff - h;
            pos.setValue(v);
            out.push({ name: l.name, position: serValue(v) });
        }
        return { aligned: out };
    };

    // ---- Generic properties & animation
    H.get_property = function (a) {
        var t = target(a);
        var p = resolveProp(t.layer, a.property);
        var o = propInfo(p, true);
        if (isProperty(p) && has(a, "time")) o.valueAtTime = serValue(p.valueAtTime(a.time, false));
        if (!isProperty(p)) { o.children = []; for (var i = 1; i <= p.numProperties; i++) o.children.push({ index: i, name: p.property(i).name, matchName: p.property(i).matchName }); }
        return o;
    };

    H.set_property = function (a) {
        var t = target(a);
        var p = resolveProp(t.layer, a.property);
        if (!isProperty(p)) fail("'" + a.property + "' is a property group, not a property");
        try {
            if (has(a, "time")) p.setValueAtTime(a.time, coerce(p, a.value));
            else if (p.numKeys > 0) p.setValueAtTime(t.comp.time, coerce(p, a.value));
            else p.setValue(coerce(p, a.value));
        } catch (e) {
            if (e.aeHint) throw e;
            fail("Cannot set '" + propPath(p) + "': " + String(e).replace(/^Error: /, ""), "Expected " + expectedType(p) + ". Current value: " + A.JSON.stringify(serValue(p.value)));
        }
        var info = propInfo(p, false);
        // with a time (or keyframes) the playhead value can differ from what was written
        var at = has(a, "time") ? a.time : (p.numKeys > 0 ? t.comp.time : null);
        if (at !== null) {
            info.time = round(at);
            info.valueSet = serValue(p.valueAtTime(at, true));
            info.valueAtPlayhead = serValue(p.valueAtTime(t.comp.time, false));
            delete info.value;
        }
        return info;
    };

    H.set_keyframes = function (a) {
        var t = target(a);
        var p = resolveProp(t.layer, a.property);
        if (!isProperty(p)) fail("'" + a.property + "' is a property group");
        if (a.replace) while (p.numKeys > 0) p.removeKey(1);
        if (a.separateDimensions && p.dimensionsSeparated === false && p.matchName === "ADBE Position") p.dimensionsSeparated = true;
        setKeys(p, a.keyframes, a.easing, { bezier: a.bezier, roving: a.roving });
        var info = propInfo(p, true);
        if (a.bezier || a.keyframes[0].bezier) {
            // report the resulting influences so callers can see the conversion
            info.eases = [];
            for (var k = 1; k <= p.numKeys; k++) info.eases.push({ key: k, inInfluence: round(p.keyInTemporalEase(k)[0].influence, 2), outInfluence: round(p.keyOutTemporalEase(k)[0].influence, 2) });
        }
        return info;
    };

    H.remove_keyframes = function (a) {
        var t = target(a);
        var p = resolveProp(t.layer, a.property);
        var removed = 0;
        for (var k = p.numKeys; k >= 1; k--) {
            var tm = p.keyTime(k);
            if (has(a, "from") && tm < a.from - 1e-6) continue;
            if (has(a, "to") && tm > a.to + 1e-6) continue;
            p.removeKey(k); removed++;
        }
        return { removed: removed, remaining: p.numKeys };
    };

    H.set_expression = function (a) {
        var t = target(a);
        var p = resolveProp(t.layer, a.property);
        if (!p.canSetExpression) fail("Property '" + p.name + "' does not accept expressions");
        p.expression = a.expression || "";
        if (has(a, "enabled")) p.expressionEnabled = !!a.enabled;
        var res = { property: propPath(p), expression: p.expression, enabled: p.expressionEnabled };
        // Force evaluation so errors surface now
        try { p.valueAtTime(t.comp.time, false); } catch (e) { }
        if (p.expressionError) {
            res.expressionError = p.expressionError;
            // like AE's UI: a broken expression stays on the property but disabled
            if (a.failOnError !== false) { p.expressionEnabled = false; res.enabled = false; }
        }
        return res;
    };

    H.check_expressions = function (a) {
        var c = getComp(a.comp);
        var errors = [], total = 0;
        function walk(g, layer) {
            for (var i = 1; i <= g.numProperties; i++) {
                var p = g.property(i);
                if (!p) continue;
                if (isProperty(p)) {
                    if (p.canSetExpression && p.expression) {
                        total++;
                        try { p.valueAtTime(c.time, false); } catch (e) { }
                        if (p.expressionError) errors.push({ layer: layer.name, property: propPath(p), error: p.expressionError });
                    }
                } else walk(p, layer);
            }
        }
        for (var i = 1; i <= c.numLayers; i++) walk(c.layer(i), c.layer(i));
        return { expressions: total, errors: errors };
    };

    // ---- Text animators
    var TA_PROPS = { opacity: "ADBE Text Opacity", position: "ADBE Text Position 3D", scale: "ADBE Text Scale 3D", rotation: "ADBE Text Rotation",
        tracking: "ADBE Text Tracking Amount", blur: "ADBE Text Blur", fillColor: "ADBE Text Fill Color", strokeColor: "ADBE Text Stroke Color", skew: "ADBE Text Skew" };
    var TA_BASED = { characters: 1, "characters-excluding-spaces": 2, words: 3, lines: 4 };
    var TA_SHAPES = { square: 1, "ramp-up": 2, "ramp-down": 3, triangle: 4, round: 5, smooth: 6 };
    function addTextAnimator(l, spec) {
        if (!(l instanceof TextLayer)) fail("Layer '" + l.name + "' is not a text layer");
        var an = l.property("ADBE Text Properties").property("ADBE Text Animators").addProperty("ADBE Text Animator");
        if (spec.name) an.name = spec.name;
        var ap = an.property("ADBE Text Animator Properties");
        var props = spec.properties || {};
        for (var k in props) {
            if (!props.hasOwnProperty(k)) continue;
            if (!TA_PROPS[k]) fail("Unknown animator property '" + k + "'", "Use opacity, position, scale, rotation, tracking, blur, fillColor, strokeColor or skew.");
            var p = ap.addProperty(TA_PROPS[k]);
            var v = props[k];
            if (k === "position" && v instanceof Array && v.length === 2) v = [v[0], v[1], 0];
            if (k === "scale" && typeof v === "number") v = [v, v, v];
            if (k === "scale" && v instanceof Array && v.length === 2) v = [v[0], v[1], 100];
            if (k === "blur" && typeof v === "number") v = [v, v];
            if (k === "fillColor" || k === "strokeColor") v = color(v);
            p.setValue(v);
        }
        var sel = spec.selector || { type: "range" };
        var type = lower(def(sel.type, "range"));
        var sels = an.property("ADBE Text Selectors"), s;
        if (type === "range") {
            s = sels.addProperty("ADBE Text Selector");
            if (has(sel, "start")) s.property("ADBE Text Percent Start").setValue(sel.start);
            if (has(sel, "end")) s.property("ADBE Text Percent End").setValue(sel.end);
            if (has(sel, "offset")) s.property("ADBE Text Percent Offset").setValue(sel.offset);
            var adv = s.property("ADBE Text Range Advanced");
            if (has(sel, "basedOn")) adv.property("ADBE Text Range Type2").setValue(TA_BASED[sel.basedOn]);
            if (has(sel, "shape")) adv.property("ADBE Text Range Shape").setValue(TA_SHAPES[sel.shape]);
            if (has(sel, "easeHigh")) adv.property("ADBE Text Levels Max Ease").setValue(sel.easeHigh);
            if (has(sel, "easeLow")) adv.property("ADBE Text Levels Min Ease").setValue(sel.easeLow);
            if (has(sel, "smoothness")) adv.property("ADBE Text Selector Smoothness").setValue(sel.smoothness);
            if (has(sel, "randomize")) adv.property("ADBE Text Randomize Order").setValue(sel.randomize ? 1 : 0);
            if (has(sel, "amount")) adv.property("ADBE Text Selector Max Amount").setValue(sel.amount);
        } else if (type === "wiggly") {
            s = sels.addProperty("ADBE Text Wiggly Selector");
            if (has(sel, "maxAmount")) s.property("ADBE Text Wiggly Max Amount").setValue(sel.maxAmount);
            if (has(sel, "minAmount")) s.property("ADBE Text Wiggly Min Amount").setValue(sel.minAmount);
            if (has(sel, "wigglesPerSecond")) s.property("ADBE Text Temporal Freq").setValue(sel.wigglesPerSecond);
            if (has(sel, "correlation")) s.property("ADBE Text Character Correlation").setValue(sel.correlation);
            if (has(sel, "basedOn")) s.property("ADBE Text Range Type2").setValue(TA_BASED[sel.basedOn]);
        } else if (type === "expression") {
            s = sels.addProperty("ADBE Text Expressible Selector");
            if (has(sel, "basedOn")) s.property("ADBE Text Range Type2").setValue(TA_BASED[sel.basedOn]);
            s.property("ADBE Text Expressible Amount").expression = def(sel.expression, "selectorValue * textIndex / textTotal");
        } else fail("Unknown selector type '" + sel.type + "'", "Use range, wiggly or expression.");
        var animated = null;
        if (spec.animate) {
            if (type !== "range") fail("animate needs a range selector");
            var map = { offset: "ADBE Text Percent Offset", start: "ADBE Text Percent Start", end: "ADBE Text Percent End" };
            var ap2 = s.property(map[def(spec.animate.property, "offset")]);
            var t0 = def(spec.animate.startTime, l.inPoint);
            setKeys(ap2, [{ time: t0, value: spec.animate.from }, { time: t0 + def(spec.animate.duration, 1), value: spec.animate.to }], def(spec.animate.easing, "smooth"));
            animated = propPath(ap2);
        }
        return { layer: l.name, animator: an.name, index: an.propertyIndex, selector: type, path: propPath(an), animated: animated };
    }
    A.addTextAnimator = addTextAnimator;
    H.add_text_animator = function (a) {
        var t = target(a);
        return addTextAnimator(t.layer, a);
    };

    // ---- Expression presets (with their own controls when useful)
    function addSlider(layer, name, value) {
        var parade = layer.property("ADBE Effect Parade");
        var fx = null;
        for (var i = 1; i <= parade.numProperties; i++) if (parade.property(i).name === name) fx = parade.property(i);
        if (!fx) { fx = parade.addProperty("ADBE Slider Control"); fx.name = name; }
        if (value !== undefined) fx.property(1).setValue(value);
        return fx;
    }
    function exprQuote(s) { return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'; }
    H.apply_expression_preset = function (a) {
        var t = target(a), l = t.layer, c = t.comp, pr = a.params || {};
        var preset = a.preset, controls = [];
        var prop = a.property ? resolveProp(l, a.property) : null;
        var expr;
        function needProp(defaultPath) { if (!prop) prop = resolveProp(l, defaultPath); return prop; }
        var dims = function () { var v = prop.value; return v instanceof Array ? v.length : 1; };
        if (preset === "loop-cycle" || preset === "loop-pingpong") {
            needProp("Position");
            if (prop.numKeys < 2) fail("'" + prop.name + "' needs at least 2 keyframes to loop", "Add keyframes with set_keyframes first.");
            expr = 'loopOut("' + (preset === "loop-cycle" ? "cycle" : "pingpong") + '")';
        } else if (preset === "inertia-bounce") {
            needProp("Position");
            expr = "amp = " + def(pr.amplitude, 0.06) + "; freq = " + def(pr.frequency, 3) + "; decay = " + def(pr.decay, 6) + ";\n" +
                "n = 0; if (numKeys > 0) { n = nearestKey(time).index; if (key(n).time > time) n--; }\n" +
                "t = n == 0 ? 0 : time - key(n).time;\n" +
                "if (n > 0 && t < 2) { v = velocityAtTime(key(n).time - thisComp.frameDuration / 10); value + v * amp * Math.sin(freq * t * 2 * Math.PI) / Math.exp(decay * t); } else value;";
        } else if (preset === "wiggle-controlled") {
            needProp("Position");
            var host = pr.controlLayer ? getLayer(c, pr.controlLayer) : l;
            addSlider(host, "Wiggle Frequency", def(pr.frequency, 2)); addSlider(host, "Wiggle Amount", def(pr.amount, 30));
            controls.push(host.name + ": Wiggle Frequency, Wiggle Amount");
            var ref = host === l ? "" : "thisComp.layer(" + exprQuote(host.name) + ").";
            expr = "wiggle(" + ref + 'effect("Wiggle Frequency")("Slider"), ' + ref + 'effect("Wiggle Amount")("Slider"))';
        } else if (preset === "link-to-slider") {
            needProp("Opacity");
            var sname = def(pr.name, prop.name + " Control");
            var cur = prop.value, d = dims();
            addSlider(l, sname, def(pr.value, cur instanceof Array ? cur[0] : cur));
            controls.push(l.name + ": " + sname);
            expr = d === 1 ? 'effect(' + exprQuote(sname) + ')("Slider")' : 's = effect(' + exprQuote(sname) + ')("Slider"); [' + (d === 3 ? "s, s, s" : "s, s") + "]";
        } else if (preset === "time-remap-loop") {
            if (!(l instanceof AVLayer) || !l.canSetTimeRemapEnabled) fail("Layer '" + l.name + "' cannot use time remapping (needs footage or a precomp)");
            l.timeRemapEnabled = true;
            prop = l.property("ADBE Time Remapping");
            l.outPoint = c.duration;
            expr = 'loopOut("cycle")';
        } else if (preset === "follow-layer") {
            needProp("Position");
            if (!pr.target) fail("follow-layer needs params.target (the layer to follow)");
            var tgt = getLayer(c, pr.target);
            var off = pr.offset ? "[" + pr.offset.join(", ") + "]" : null;
            expr = "d = " + def(pr.delay, 0.2) + ";\nthisComp.layer(" + exprQuote(tgt.name) + ").transform.position.valueAtTime(time - d)" + (off ? " + " + off : "");
        } else if (preset === "fit-text-box") {
            if (!(l instanceof TextLayer)) fail("fit-text-box needs a text layer");
            prop = l.property("ADBE Transform Group").property("ADBE Scale");
            var bw = def(pr.width, c.width * 0.8), bh = def(pr.height, c.height);
            expr = "r = sourceRectAtTime(time, false);\ns = Math.min(" + def(pr.maxScale, 100) + ", " + bw + " / Math.max(r.width, 1) * 100, " + bh + " / Math.max(r.height, 1) * 100);\n[s, s" + (dims() === 3 ? ", s" : "") + "]";
        } else if (preset === "counter-number") {
            if (!(l instanceof TextLayer)) fail("counter-number needs a text layer");
            prop = l.property("ADBE Text Properties").property("ADBE Text Document");
            var sl = addSlider(l, "Counter", def(pr.from, 0));
            var st = def(pr.startTime, l.inPoint), du = def(pr.duration, 2);
            setKeys(sl.property(1), [{ time: st, value: def(pr.from, 0) }, { time: st + du, value: def(pr.to, 100) }], def(pr.easing, "smooth"));
            controls.push(l.name + ": Counter (keyframed " + def(pr.from, 0) + " -> " + def(pr.to, 100) + ")");
            var dec = def(pr.decimals, 0);
            var body = dec > 0 ? "v.toFixed(" + dec + ")" : "Math.round(v).toString()";
            if (pr.thousands) body = "(" + body + ').replace(/\\B(?=(\\d{3})+(?!\\d))/g, ' + exprQuote(pr.thousands) + ")";
            expr = 'v = effect("Counter")("Slider");\n' + exprQuote(def(pr.prefix, "")) + " + " + body + " + " + exprQuote(def(pr.suffix, ""));
        } else fail("Unknown expression preset '" + preset + "'");
        if (!prop.canSetExpression) fail("Property '" + prop.name + "' does not accept expressions");
        prop.expression = expr;
        try { prop.valueAtTime(c.time, false); } catch (e) { }
        var res = { layer: l.name, property: propPath(prop), preset: preset, expression: prop.expression, controls: controls };
        if (prop.expressionError) { res.expressionError = prop.expressionError; prop.expressionEnabled = false; }
        return res;
    };

    // Procedural animation presets: keyframes and expressions built for you.
    H.animate_layer = function (a) {
        var t = target(a);
        var l = t.layer, c = t.comp;
        var tg = l.property("ADBE Transform Group");
        var start = def(a.startTime, l.inPoint);
        var dur = def(a.duration, 0.6);
        var end = start + dur;
        var ease = def(a.easing, "smooth");
        var preset = lower(a.preset);
        var pos = tg.property("ADBE Position"), sc = tg.property("ADBE Scale"), op = tg.property("ADBE Opacity"), rot = tg.property("ADBE Rotate Z");
        var amt = a.amount;
        var applied = [];
        function keys(p, v0, v1, e) { setKeys(p, [{ time: start, value: v0 }, { time: end, value: v1 }], e || ease); applied.push(p.name); }
        function keysOut(p, v0, v1, e) { var s2 = def(a.startTime, l.outPoint - dur); setKeys(p, [{ time: s2, value: v0 }, { time: s2 + dur, value: v1 }], e || ease); applied.push(p.name); }
        function expr(p, e) { p.expression = e; applied.push(p.name + " (expression)"); }
        var P = pos.value, S = sc.value;
        var dir = lower(def(a.direction, "left"));
        var dist = def(amt, null);
        function offsetFor(d) {
            var r = l.sourceRectAtTime(start, false);
            var w = c.width, h = c.height;
            var dx = 0, dy = 0;
            if (d === "left") dx = -(dist !== null ? dist : P[0] + r.width);
            if (d === "right") dx = dist !== null ? dist : (w - P[0]) + r.width;
            if (d === "top" || d === "up") dy = -(dist !== null ? dist : P[1] + r.height);
            if (d === "bottom" || d === "down") dy = dist !== null ? dist : (h - P[1]) + r.height;
            var o = P.slice(0); o[0] += dx; o[1] += dy; return o;
        }
        switch (preset) {
            case "fade-in": keys(op, 0, def(a.targetValue, op.value || 100), ease === "smooth" ? "linear" : ease); break;
            case "fade-out": keysOut(op, op.value, 0, ease === "smooth" ? "linear" : ease); break;
            case "slide-in": keys(pos, offsetFor(dir), P); break;
            case "slide-out": keysOut(pos, P, offsetFor(dir)); break;
            case "slide-up-fade": { var o = P.slice(0); o[1] += def(amt, 80); keys(pos, o, P); keys(op, 0, 100, "ease-out"); break; }
            case "scale-in": { var z = S.slice(0); for (var i = 0; i < z.length; i++) z[i] = 0; keys(sc, z, S); break; }
            case "scale-out": { var z2 = S.slice(0); for (var j = 0; j < z2.length; j++) z2[j] = 0; keysOut(sc, S, z2); break; }
            case "pop": {
                var z3 = [], over = [];
                var k = def(amt, 115) / 100;
                for (var q = 0; q < S.length; q++) { z3.push(0); over.push(S[q] * k); }
                setKeys(sc, [{ time: start, value: z3 }, { time: start + dur * 0.6, value: over }, { time: end, value: S }], "smooth");
                applied.push("Scale"); break;
            }
            case "rotate-in": keys(rot, rot.value - def(amt, 180), rot.value); keys(op, 0, 100, "linear"); break;
            case "spin": keys(rot, rot.value, rot.value + def(amt, 360)); break;
            case "blur-in": {
                var fx = l.property("ADBE Effect Parade").addProperty("ADBE Gaussian Blur 2");
                var bl = fx.property("ADBE Gaussian Blur 2-0001");
                setKeys(bl, [{ time: start, value: def(amt, 60) }, { time: end, value: 0 }], ease);
                try { fx.property("ADBE Gaussian Blur 2-0003").setValue(1); } catch (e) { }
                keys(op, 0, 100, "linear");
                applied.push("Gaussian Blur"); break;
            }
            case "typewriter": {
                // hidden characters (opacity 0) behind a Start that sweeps 0 -> 100
                addTextAnimator(l, { name: "Typewriter", properties: { opacity: 0 }, selector: { type: "range", smoothness: 0 }, animate: { property: "start", from: 0, to: 100, startTime: start, duration: def(a.duration, 2), easing: "linear" } });
                applied.push("Text Animator (Typewriter)"); break;
            }
            case "text-fade-up": {
                // Ramp Up: Offset -100 selects every character (hidden, lowered), +100 none
                addTextAnimator(l, { name: "Fade Up", properties: { opacity: 0, position: [0, def(amt, 60), 0] }, selector: { type: "range", shape: "ramp-up", easeHigh: 50 }, animate: { property: "offset", from: -100, to: 100, startTime: start, duration: def(a.duration, 1.2), easing: "smooth" } });
                applied.push("Text Animator (Fade Up)"); break;
            }
            case "wiggle": expr(pos, "wiggle(" + def(a.frequency, 2) + "," + def(amt, 30) + ")"); break;
            case "wiggle-rotation": expr(rot, "wiggle(" + def(a.frequency, 2) + "," + def(amt, 10) + ")"); break;
            case "pulse": expr(sc, "s=" + def(amt, 8) + "*Math.sin(time*" + def(a.frequency, 2) + "*Math.PI*2);value+[s,s" + (S.length === 3 ? ",s" : "") + "]"); break;
            case "float": expr(pos, "value+[0," + def(amt, 15) + "*Math.sin(time*" + def(a.frequency, 0.5) + "*Math.PI*2)" + (P.length === 3 ? ",0" : "") + "]"); break;
            case "rotate-continuous": expr(rot, "value+time*" + def(amt, 90)); break;
            case "blink": expr(op, "Math.round(time*" + def(a.frequency, 2) + ")%2==0?100:0"); break;
            case "bounce": {
                var src = pos.numKeys > 0 ? pos : (sc.numKeys > 0 ? sc : null);
                var targetP = a.property ? resolveProp(l, a.property) : src;
                if (!targetP) fail("bounce needs an animated property (keyframes) or 'property'");
                expr(targetP, "amp=" + def(amt, 0.06) + ";freq=" + def(a.frequency, 3) + ";decay=" + def(a.decay, 6) + ";\nn=0;if(numKeys>0){n=nearestKey(time).index;if(key(n).time>time)n--;}\nt=n==0?0:time-key(n).time;\nif(n>0&&t<1){v=velocityAtTime(key(n).time-thisComp.frameDuration/10);value+v*amp*Math.sin(freq*t*2*Math.PI)/Math.exp(decay*t);}else value;");
                break;
            }
            case "loop": {
                var lp = a.property ? resolveProp(l, a.property) : pos;
                expr(lp, "loopOut(\"" + def(a.loopType, "cycle") + "\")"); break;
            }
            default: fail("Unknown preset '" + a.preset + "'");
        }
        return { layer: l.name, preset: preset, start: round(start), end: round(end), applied: applied };
    };

    // ---- Effects
    // app.effects builds a new array of ~1000 objects on EVERY access: read it once per session.
    function effectsList() {
        if (!A._effects) {
            var src = app.effects, out = [];
            for (var i = 0, n = src.length; i < n; i++) { var e = src[i]; out.push({ displayName: e.displayName, matchName: e.matchName, category: e.category }); }
            A._effects = out;
        }
        return A._effects;
    }
    H.list_available_effects = function (a) {
        var out = [];
        var q = a.query ? lower(a.query) : null;
        var all = effectsList();
        for (var i = 0; i < all.length; i++) {
            var e = all[i];
            if (q && lower(e.displayName).indexOf(q) < 0 && lower(e.matchName).indexOf(q) < 0 && lower(e.category).indexOf(q) < 0) continue;
            if (a.category && lower(e.category) !== lower(a.category)) continue;
            out.push({ name: e.displayName, matchName: e.matchName, category: e.category });
            if (out.length >= def(a.limit, 200)) break;
        }
        return { count: out.length, effects: out };
    };

    function findEffectMatch(name) {
        var n = lower(name), fx = effectsList(), i;
        for (i = 0; i < fx.length; i++) if (lower(fx[i].matchName) === n) return fx[i].matchName;
        for (i = 0; i < fx.length; i++) if (lower(fx[i].displayName) === n) return fx[i].matchName;
        var cands = [];
        for (i = 0; i < fx.length; i++) if (lower(fx[i].displayName).indexOf(n) >= 0) cands.push(fx[i]);
        if (cands.length === 1) return cands[0].matchName;
        if (!cands.length) {
            // fuzzy: same letters ignoring spaces/case, allowing 2 typos (e.g. "Gausian Blurr")
            var key = n.replace(/[^a-z0-9]/g, "");
            for (i = 0; i < fx.length; i++) if (dist(lower(fx[i].displayName).replace(/[^a-z0-9]/g, ""), key) <= 2) cands.push(fx[i]);
        }
        var names = [];
        for (i = 0; i < Math.min(cands.length, 12); i++) names.push(cands[i].displayName + " [" + cands[i].matchName + "]");
        fail("Effect '" + name + "' not found" + (cands.length > 1 ? " (ambiguous)" : ""), names.length ? "Did you mean: " + names.join(", ") : "Use list_available_effects to search.");
    }
    function dist(a, b) {
        if (Math.abs(a.length - b.length) > 2) return 99;
        var prev = [], cur, i, j;
        for (j = 0; j <= b.length; j++) prev.push(j);
        for (i = 1; i <= a.length; i++) {
            cur = [i];
            for (j = 1; j <= b.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1)));
            prev = cur;
        }
        return prev[b.length];
    }

    function blank(str) { return String(str).replace(/^\s+|\s+$/g, "") === ""; }
    // Every leaf parameter of an effect with its path ("Vignette/Amount"). Real groups
    // nest; effects like Lumetri are flat lists where a NO_VALUE "topic" parameter opens a
    // section and a NO_VALUE parameter with a blank name closes it.
    function effectLeaves(group, prefix, out) {
        var topics = [];
        for (var i = 1; i <= group.numProperties; i++) {
            var p = group.property(i);
            if (!p) continue;
            var base = prefix;
            for (var t = 0; t < topics.length; t++) base = base ? base + "/" + topics[t] : topics[t];
            if (isProperty(p)) {
                if (p.propertyValueType === PropertyValueType.NO_VALUE) {
                    if (blank(p.name)) topics.pop(); else topics.push(p.name);
                    continue;
                }
                out.push({ prop: p, path: base ? base + "/" + p.name : p.name });
            } else effectLeaves(p, base ? base + "/" + p.name : p.name, out);
        }
        return out;
    }
    // Finds a parameter by "Topic/Param" path, name, match name, or "Topic Param"
    // (Lumetri "Vignette Amount"), searching nested groups and flat topics.
    function findEffectParam(fx, key) {
        var k = lower(key), i;
        var direct = child(fx, key);
        if (direct && isProperty(direct) && direct.propertyValueType !== PropertyValueType.NO_VALUE) return direct;
        var leaves = effectLeaves(fx, "", []);
        for (i = 0; i < leaves.length; i++) if (lower(leaves[i].path) === k) return leaves[i].prop;
        for (i = 0; i < leaves.length; i++) if (lower(leaves[i].path.replace(/\//g, " ")) === k) return leaves[i].prop;
        for (i = 0; i < leaves.length; i++) if (lower(leaves[i].prop.name) === k || lower(leaves[i].prop.matchName) === k) return leaves[i].prop;
        for (i = 0; i < leaves.length; i++) {
            var path = lower(leaves[i].path);
            if (path.length > k.length && path.substr(path.length - k.length - 1) === "/" + k) return leaves[i].prop;
        }
        // "Vignette Amount" / "Vignette/Amount": the key ends with the parameter name and the
        // rest names one of its sections (section nesting in flat effects is not reliable)
        for (i = 0; i < leaves.length; i++) {
            var nm = lower(leaves[i].prop.name);
            if (k.length <= nm.length || k.substr(k.length - nm.length) !== nm) continue;
            var rest = k.substr(0, k.length - nm.length).replace(/[\/\s]+$/, "");
            if (!rest) continue;
            var segsP = lower(leaves[i].path).split("/");
            for (var sg = 0; sg < segsP.length - 1; sg++) if (segsP[sg] === rest) return leaves[i].prop;
        }
        for (i = 0; i < leaves.length; i++) if (lower(leaves[i].prop.name).indexOf(k) === 0) return leaves[i].prop;
        return null;
    }
    function nearestParams(fx, key, n) {
        var k = lower(key).replace(/[^a-z0-9]/g, "");
        var leaves = effectLeaves(fx, "", []), scored = [];
        for (var i = 0; i < leaves.length; i++) {
            var name = lower(leaves[i].path).replace(/[^a-z0-9]/g, "");
            var score = name.indexOf(k) >= 0 || k.indexOf(lower(leaves[i].prop.name).replace(/[^a-z0-9]/g, "")) >= 0 ? 0 : dist(name.substr(0, k.length + 2), k);
            scored.push({ s: score, p: leaves[i].path });
        }
        scored.sort(function (a, b) { return a.s - b.s; });
        var out = [];
        for (var j = 0; j < scored.length && out.length < n; j++) out.push(scored[j].p);
        return out;
    }

    function setEffectParams(fx, params) {
        var applied = [], errors = [];
        for (var k in params) {
            if (!params.hasOwnProperty(k)) continue;
            try {
                var p = findEffectParam(fx, k);
                if (!p) {
                    var near = nearestParams(fx, k, 10);
                    errors.push(k + ": parameter not found" + (near.length ? " (closest: " + near.join(", ") + ")" : ""));
                    continue;
                }
                var v = params[k];
                if (v !== null && typeof v === "object" && !(v instanceof Array) && v.keyframes) setKeys(p, v.keyframes, v.easing);
                else if (v !== null && typeof v === "object" && !(v instanceof Array) && v.expression) p.expression = v.expression;
                else if (p.numKeys > 0) p.setValueAtTime(fx.propertyGroup(fx.propertyDepth).containingComp.time, coerce(p, v));
                else p.setValue(coerce(p, v));
                applied.push(p.name);
            } catch (e) { errors.push(k + ": " + e.toString()); }
        }
        return { applied: applied, errors: errors };
    }

    function effectParams(fx) {
        var ps = [];
        for (var i = 1; i <= fx.numProperties; i++) {
            var p = fx.property(i);
            if (!isProperty(p)) continue;
            if (p.propertyValueType === PropertyValueType.NO_VALUE || p.propertyValueType === PropertyValueType.CUSTOM_VALUE) continue;
            var o = { index: i, name: p.name, matchName: p.matchName };
            try { o.value = serValue(p.value); } catch (e) { }
            if (p.numKeys) o.numKeys = p.numKeys;
            if (p.expression) o.expression = p.expression;
            ps.push(o);
        }
        return ps;
    }

    H.apply_effect = function (a) {
        var c = getComp(a.comp);
        var layers = getLayers(c, has(a, "layers") ? a.layers : a.layer);
        var mn = findEffectMatch(a.effect);
        var out = [];
        for (var i = 0; i < layers.length; i++) {
            var parade = layers[i].property("ADBE Effect Parade");
            if (!parade.canAddProperty(mn)) fail("Effect '" + a.effect + "' cannot be added to layer '" + layers[i].name + "'");
            var fx = parade.addProperty(mn);
            if (a.name) fx.name = a.name;
            var r = a.params ? setEffectParams(fx, a.params) : { applied: [], errors: [] };
            out.push({ layer: layers[i].name, effect: fx.name, matchName: fx.matchName, index: fx.propertyIndex, set: r.applied, errors: r.errors, params: a.returnParams === false ? undefined : effectParams(fx) });
        }
        return { results: out };
    };

    function getEffect(layer, ref) {
        var parade = layer.property("ADBE Effect Parade");
        if (!parade.numProperties) fail("Layer '" + layer.name + "' has no effects");
        var fx = child(parade, ref);
        if (!fx) { try { fx = parade.property(findEffectMatch(ref)); } catch (e) { fx = null; } }
        if (!fx) { var names = []; for (var i = 1; i <= parade.numProperties; i++) names.push(parade.property(i).name); fail("Effect '" + ref + "' not found on '" + layer.name + "'", "Effects: " + names.join(", ")); }
        return fx;
    }

    H.get_layer_effects = function (a) {
        var t = target(a);
        var parade = t.layer.property("ADBE Effect Parade");
        var out = [];
        for (var i = 1; i <= parade.numProperties; i++) {
            var fx = parade.property(i);
            out.push({ index: i, name: fx.name, matchName: fx.matchName, enabled: fx.enabled, params: effectParams(fx) });
        }
        return { layer: t.layer.name, effects: out };
    };

    H.modify_effect = function (a) {
        var t = target(a);
        var fx = getEffect(t.layer, a.effect);
        if (a.remove) { var n = fx.name; fx.remove(); return { removed: n }; }
        if (has(a, "enabled")) fx.enabled = !!a.enabled;
        if (has(a, "newName")) fx.name = a.newName;
        if (has(a, "moveTo")) fx.moveTo(a.moveTo);
        if (a.duplicate) fx = fx.duplicate();
        var r = a.params ? setEffectParams(fx, a.params) : { applied: [], errors: [] };
        return { effect: fx.name, set: r.applied, errors: r.errors, params: effectParams(fx) };
    };

    var FX_TEMPLATES = {
        "gaussian-blur": [["ADBE Gaussian Blur 2", { "ADBE Gaussian Blur 2-0001": 20, "ADBE Gaussian Blur 2-0003": 1 }]],
        "directional-blur": [["ADBE Motion Blur", { "ADBE Motion Blur-0001": 90, "ADBE Motion Blur-0002": 20 }]],
        "glow": [["ADBE Glo2", { "ADBE Glo2-0002": 50, "ADBE Glo2-0003": 30, "ADBE Glo2-0004": 1.5 }]],
        "soft-glow": [["ADBE Glo2", { "ADBE Glo2-0002": 70, "ADBE Glo2-0003": 80, "ADBE Glo2-0004": 0.8 }]],
        "drop-shadow": [["ADBE Drop Shadow", { "ADBE Drop Shadow-0002": 60, "ADBE Drop Shadow-0004": 12, "ADBE Drop Shadow-0005": 18 }]],
        "long-shadow": [["ADBE Drop Shadow", { "ADBE Drop Shadow-0002": 80, "ADBE Drop Shadow-0004": 40, "ADBE Drop Shadow-0005": 0 }]],
        "brightness-contrast": [["ADBE Brightness & Contrast 2", { "ADBE Brightness & Contrast 2-0001": 10, "ADBE Brightness & Contrast 2-0002": 15 }]],
        "vibrance": [["ADBE Vibrance", { "ADBE Vibrance-0001": 30, "ADBE Vibrance-0002": 5 }]],
        "black-and-white": [["ADBE Black&White", {}]],
        "sepia": [["ADBE Tint", { "ADBE Tint-0001": [0.15, 0.1, 0.05], "ADBE Tint-0002": [1, 0.92, 0.75] }]],
        "vignette": [["ADBE Exposure2", {}]],
        "cinematic-look": [["ADBE Vibrance", { "ADBE Vibrance-0001": -10, "ADBE Vibrance-0002": -5 }], ["ADBE Brightness & Contrast 2", { "ADBE Brightness & Contrast 2-0002": 18 }], ["ADBE Tint", { "ADBE Tint-0001": [0.02, 0.1, 0.14], "ADBE Tint-0002": [1, 0.85, 0.7], "ADBE Tint-0003": 25 }]],
        "text-pop": [["ADBE Drop Shadow", { "ADBE Drop Shadow-0002": 70, "ADBE Drop Shadow-0004": 6, "ADBE Drop Shadow-0005": 10 }], ["ADBE Glo2", { "ADBE Glo2-0002": 60, "ADBE Glo2-0003": 15, "ADBE Glo2-0004": 0.6 }]],
        "film-grain": [["ADBE Noise", { "ADBE Noise-0001": 8 }]],
        "chromatic-aberration": [["ADBE Shift Channels", {}]],
        "neon": [["ADBE Glo2", { "ADBE Glo2-0002": 40, "ADBE Glo2-0003": 25, "ADBE Glo2-0004": 2 }], ["ADBE Glo2", { "ADBE Glo2-0002": 40, "ADBE Glo2-0003": 120, "ADBE Glo2-0004": 1 }]],
        "stroke-outline": [["ADBE Layer Styles Stroke", {}]],
        "sharpen": [["ADBE Sharpen", { "ADBE Sharpen-0001": 25 }]],
        "posterize-time": [["ADBE Posterize Time", { "ADBE Posterize Time-0001": 12 }]]
    };
    H.apply_effect_template = function (a) {
        var c = getComp(a.comp);
        var layers = getLayers(c, has(a, "layers") ? a.layers : a.layer);
        var tpl = FX_TEMPLATES[lower(a.template)];
        if (!tpl) fail("Unknown template '" + a.template + "'");
        var out = [];
        for (var i = 0; i < layers.length; i++) {
            var parade = layers[i].property("ADBE Effect Parade");
            var added = [];
            for (var j = 0; j < tpl.length; j++) {
                if (tpl[j][0] === "ADBE Layer Styles Stroke") continue;
                if (!parade.canAddProperty(tpl[j][0])) continue;
                var fx = parade.addProperty(tpl[j][0]);
                setEffectParams(fx, tpl[j][1]);
                if (j === tpl.length - 1 && a.params) setEffectParams(fx, a.params);
                if (lower(a.template) === "vignette") { fx.remove(); fx = addVignette(layers[i]); }
                added.push(fx ? fx.name : "vignette");
            }
            if (lower(a.template) === "stroke-outline") { try { app.executeCommand(9008); } catch (e) { } }
            out.push({ layer: layers[i].name, added: added });
        }
        return { template: a.template, results: out };
    };
    function addVignette(layer) {
        // Vignette = CC Vignette when available, else a Fast Box Blur-free solid fallback via Exposure is skipped
        var parade = layer.property("ADBE Effect Parade");
        if (parade.canAddProperty("CC Vignette")) { var v = parade.addProperty("CC Vignette"); try { v.property(1).setValue(80); } catch (e) { } return v; }
        return null;
    }

    H.apply_preset_file = function (a) {
        var t = target(a);
        var f = new File(a.presetPath);
        if (!f.exists) fail("Preset file not found: " + a.presetPath);
        var prevSel = t.comp.selectedLayers;
        for (var i = 0; i < prevSel.length; i++) prevSel[i].selected = false;
        t.layer.selected = true;
        if (has(a, "time")) t.comp.time = a.time;
        t.layer.applyPreset(f);
        return layerSummary(t.layer);
    };

    // ---- Masks
    H.add_mask = function (a) {
        var t = target(a);
        var l = t.layer;
        var masks = l.property("ADBE Mask Parade");
        var m = masks.addProperty("ADBE Mask Atom");
        var shape;
        var type = lower(def(a.shape, "rectangle"));
        var r;
        try { r = l.sourceRectAtTime(t.comp.time, false); } catch (e) { r = { left: 0, top: 0, width: t.comp.width, height: t.comp.height }; }
        var rect = def(a.rect, [r.left, r.top, r.width, r.height]);
        var x = rect[0], y = rect[1], w = rect[2], h = rect[3];
        if (type === "rectangle") shape = { vertices: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], closed: true };
        else if (type === "ellipse") {
            var kx = w / 2 * 0.5523, ky = h / 2 * 0.5523, cx = x + w / 2, cy = y + h / 2;
            shape = { vertices: [[cx, y], [x + w, cy], [cx, y + h], [x, cy]], inTangents: [[-kx, 0], [0, -ky], [kx, 0], [0, ky]], outTangents: [[kx, 0], [0, ky], [-kx, 0], [0, -ky]], closed: true };
        } else if (type === "path") shape = { vertices: a.vertices, inTangents: a.inTangents, outTangents: a.outTangents, closed: def(a.closed, true) };
        else fail("Unknown mask shape '" + a.shape + "'");
        m.property("ADBE Mask Shape").setValue(toShape(shape));
        var modes = { add: MaskMode.ADD, subtract: MaskMode.SUBTRACT, intersect: MaskMode.INTERSECT, lighten: MaskMode.LIGHTEN, darken: MaskMode.DARKEN, difference: MaskMode.DIFFERENCE, none: MaskMode.NONE };
        if (a.mode) m.maskMode = modes[lower(a.mode)];
        if (has(a, "inverted")) m.inverted = !!a.inverted;
        if (has(a, "feather")) m.property("ADBE Mask Feather").setValue(typeof a.feather === "number" ? [a.feather, a.feather] : a.feather);
        if (has(a, "opacity")) m.property("ADBE Mask Opacity").setValue(a.opacity);
        if (has(a, "expansion")) m.property("ADBE Mask Offset").setValue(a.expansion);
        if (a.name) m.name = a.name;
        return { layer: l.name, mask: m.name, index: m.propertyIndex, numMasks: masks.numProperties };
    };

    H.remove_masks = function (a) {
        var t = target(a);
        var masks = t.layer.property("ADBE Mask Parade");
        var removed = [];
        for (var i = masks.numProperties; i >= 1; i--) {
            var m = masks.property(i);
            if (a.mask !== undefined && !(m.name === a.mask || i === a.mask)) continue;
            removed.push(m.name); m.remove();
        }
        return { removed: removed };
    };

    // ---- Audio
    function audioLevels(l) {
        if (!(l instanceof AVLayer) || !l.hasAudio) fail("Layer '" + l.name + "' has no audio");
        return l.property("ADBE Audio Group").property("ADBE Audio Levels");
    }
    function setAudio(l, a) {
        var lv = audioLevels(l);
        if (has(a, "audioLevels")) {
            var v = a.audioLevels;
            if (v instanceof Array) setKeys(lv, (function () { var k = []; for (var i = 0; i < v.length; i++) k.push({ time: v[i].time, value: [v[i].value, v[i].value] }); return k; })(), "linear");
            else lv.setValue([v, v]);
        }
        if (a.audioFade) {
            var cur = lv.valueAtTime(l.inPoint, true), base = cur instanceof Array ? cur[0] : cur, keys = [];
            if (a.audioFade["in"]) { keys.push({ time: l.inPoint, value: [-48, -48] }); keys.push({ time: l.inPoint + a.audioFade["in"], value: [base, base] }); }
            if (a.audioFade.out) { keys.push({ time: l.outPoint - a.audioFade.out, value: [base, base] }); keys.push({ time: l.outPoint, value: [-48, -48] }); }
            if (keys.length) setKeys(lv, keys, "linear");
        }
    }
    A.setAudio = setAudio;

    // Animation > Keyframe Assistant > Convert Audio to Keyframes: makes an "Audio Amplitude" null
    var CONVERT_AUDIO = 4218;
    H.audio_to_keyframes = function (a) {
        var t = target(a);
        if (!(t.layer instanceof AVLayer) || !t.layer.hasAudio) fail("Layer '" + t.layer.name + "' has no audio");
        var c = t.comp;
        var before = {};
        for (var i = 1; i <= c.numLayers; i++) before[c.layer(i).id] = true;
        c.openInViewer();
        for (var j = 1; j <= c.numLayers; j++) c.layer(j).selected = false;
        t.layer.selected = true;
        var id = app.findMenuCommandId("Convert Audio to Keyframes") || CONVERT_AUDIO;
        app.executeCommand(id);
        var made = null;
        for (var k = 1; k <= c.numLayers; k++) if (!before[c.layer(k).id]) made = c.layer(k);
        if (!made) fail("Convert Audio to Keyframes did not create a layer", "The comp must be open in the viewer and the audio layer selected.");
        var fx = made.property("ADBE Effect Parade"), sliders = [];
        for (var s = 1; s <= fx.numProperties; s++) sliders.push({ name: fx.property(s).name, keys: fx.property(s).property(1).numKeys });
        return { layer: made.name, id: made.id, sliders: sliders };
    };

    // comp markers at local peaks of an amplitude slider (default: "Both Channels" of "Audio Amplitude")
    H.markers_from_audio_peaks = function (a) {
        var c = getComp(a.comp);
        var amp = getLayer(c, def(a.amplitudeLayer, "Audio Amplitude"));
        var slider = resolveProp(amp, "Effects/" + def(a.channel, "Both Channels") + "/Slider");
        var n = slider.numKeys, thr = def(a.threshold, 10), gap = def(a.minGap, 0.15), last = -1e9, added = [];
        if (n < 3) fail("No amplitude keyframes on '" + amp.name + "'", "Run audio_to_keyframes first.");
        for (var i = 2; i < n; i++) {
            var v = slider.keyValue(i), t = slider.keyTime(i);
            if (v >= thr && v >= slider.keyValue(i - 1) && v > slider.keyValue(i + 1) && t - last >= gap) {
                var m = new MarkerValue(def(a.comment, "peak") + " " + round(v, 1));
                c.markerProperty.setValueAtTime(t, m);
                added.push(round(t, 3));
                last = t;
            }
        }
        return { markers: added.length, times: added, threshold: thr };
    };

    // ---- Keyframes on markers (animate on the beat)
    H.keyframes_from_markers = function (a) {
        var t = target(a);
        var mp = def(a.markerSource, "comp") === "layer" ? t.layer.property("ADBE Marker") : t.comp.markerProperty;
        if (!mp.numKeys) fail("No markers on the " + def(a.markerSource, "comp"), "Add some with markers {action:'add'} or markers_from_audio_peaks.");
        var p = resolveProp(t.layer, a.property);
        if (!isProperty(p) || !p.canVaryOverTime) fail("'" + a.property + "' cannot be keyframed");
        var vals = a.values;
        if (!vals || !vals.length) fail("Pass values: one per marker, or two with pattern:'alternate'");
        var keys = [];
        for (var i = 1; i <= mp.numKeys; i++) {
            var v = a.pattern === "alternate" ? vals[(i - 1) % vals.length] : vals[Math.min(i - 1, vals.length - 1)];
            keys.push({ time: mp.keyTime(i) + def(a.offset, 0), value: v });
        }
        if (a.replace) while (p.numKeys > 0) p.removeKey(1);
        setKeys(p, keys, def(a.easing, "easy-ease"));
        return { property: propPath(p), keys: keys.length, times: (function () { var o = []; for (var j = 0; j < keys.length; j++) o.push(round(keys[j].time, 3)); return o; })() };
    };

    // ---- Motion along a path (mask or shape path) -> Position keyframes
    function toCompPoint(layer, pt, time) {
        // 2D layer transform: position + R(rotation) * ((pt - anchor) * scale)
        var tg = layer.property("ADBE Transform Group");
        var ap = tg.property("ADBE Anchor Point").valueAtTime(time, false), pos = tg.property("ADBE Position").valueAtTime(time, false);
        var sc = tg.property("ADBE Scale").valueAtTime(time, false), r = tg.property("ADBE Rotate Z").valueAtTime(time, false) * Math.PI / 180;
        var x = (pt[0] - ap[0]) * sc[0] / 100, y = (pt[1] - ap[1]) * sc[1] / 100;
        return [pos[0] + x * Math.cos(r) - y * Math.sin(r), pos[1] + x * Math.sin(r) + y * Math.cos(r)];
    }
    function toCompVector(layer, v, time) {
        var tg = layer.property("ADBE Transform Group");
        var sc = tg.property("ADBE Scale").valueAtTime(time, false), r = tg.property("ADBE Rotate Z").valueAtTime(time, false) * Math.PI / 180;
        var x = v[0] * sc[0] / 100, y = v[1] * sc[1] / 100;
        return [x * Math.cos(r) - y * Math.sin(r), x * Math.sin(r) + y * Math.cos(r)];
    }
    function segLength(p0, o0, i1, p1) {
        // cubic bezier length by sampling
        var c1 = [p0[0] + o0[0], p0[1] + o0[1]], c2 = [p1[0] + i1[0], p1[1] + i1[1]], len = 0, prev = p0;
        for (var s = 1; s <= 16; s++) {
            var u = s / 16, w = 1 - u;
            var x = w * w * w * p0[0] + 3 * w * w * u * c1[0] + 3 * w * u * u * c2[0] + u * u * u * p1[0];
            var y = w * w * w * p0[1] + 3 * w * w * u * c1[1] + 3 * w * u * u * c2[1] + u * u * u * p1[1];
            len += Math.sqrt((x - prev[0]) * (x - prev[0]) + (y - prev[1]) * (y - prev[1]));
            prev = [x, y];
        }
        return len;
    }
    H.position_along_path = function (a) {
        var c = getComp(a.comp);
        var l = getLayer(c, a.layer), pl = getLayer(c, a.pathLayer);
        var pp = a.pathProperty ? resolveProp(pl, a.pathProperty) : null;
        if (!pp) {
            try { pp = pl.property("ADBE Mask Parade").property(1).property("ADBE Mask Shape"); } catch (e) { pp = null; }
        }
        if (!pp || pp.propertyValueType !== PropertyValueType.SHAPE) fail("No path found on '" + pl.name + "'", "Pass pathProperty, e.g. 'Masks/Mask 1/Mask Path' or a shape layer 'Contents/Shape 1/Contents/Path 1/Path'.");
        var start = def(a.startTime, l.inPoint), dur = def(a.duration, 2);
        var sh = pp.valueAtTime(start, false);
        // shape paths live inside their group: add the group's position when reading a shape layer path
        var off = [0, 0];
        try { var grp = pp.propertyGroup(3); var gp = grp.property("ADBE Vector Transform Group").property("ADBE Vector Position").value; off = [gp[0], gp[1]]; } catch (e2) { }
        var n = sh.vertices.length, pts = [], ins = [], outs = [];
        for (var i = 0; i < n; i++) {
            var v = [sh.vertices[i][0] + off[0], sh.vertices[i][1] + off[1]];
            pts.push(toCompPoint(pl, v, start));
            ins.push(toCompVector(pl, sh.inTangents[i], start));
            outs.push(toCompVector(pl, sh.outTangents[i], start));
        }
        var order = []; for (var k = 0; k < n; k++) order.push(k);
        if (sh.closed) order.push(0);
        var lens = [0], total = 0;
        for (var j = 1; j < order.length; j++) {
            total += segLength(pts[order[j - 1]], outs[order[j - 1]], ins[order[j]], pts[order[j]]);
            lens.push(total);
        }
        if (total <= 0) fail("Path has no length");
        var pos = l.property("ADBE Transform Group").property("ADBE Position");
        if (a.replace !== false) while (pos.numKeys > 0) pos.removeKey(1);
        var dims = pos.value.length;
        for (var m = 0; m < order.length; m++) {
            var tm = start + dur * lens[m] / total;
            var pt = pts[order[m]];
            var key = pos.addKey(tm);
            pos.setValueAtKey(key, dims === 3 ? [pt[0], pt[1], pos.value[2]] : pt);
        }
        for (var q2 = 1; q2 <= pos.numKeys; q2++) {
            var idx = order[q2 - 1];
            var tin = ins[idx], tout = outs[idx];
            if (!sh.closed && q2 === 1) tin = [0, 0];
            if (!sh.closed && q2 === pos.numKeys) tout = [0, 0];
            pos.setSpatialTangentsAtKey(q2, dims === 3 ? [tin[0], tin[1], 0] : tin, dims === 3 ? [tout[0], tout[1], 0] : tout);
            pos.setInterpolationTypeAtKey(q2, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
            // constant speed along the path
            if (q2 > 1 && q2 < pos.numKeys) { try { pos.setRovingAtKey(q2, true); } catch (e3) { } }
        }
        if (a.autoOrient) l.autoOrient = AutoOrientType.ALONG_PATH;
        return { layer: l.name, keys: pos.numKeys, length: round(total, 2), start: round(start), end: round(start + dur) };
    };

    // ---- Markers
    function listMarkers(mp) {
        var out = [];
        for (var i = 1; i <= mp.numKeys; i++) { var v = mp.keyValue(i); out.push({ index: i, time: round(mp.keyTime(i)), comment: v.comment, duration: round(v.duration), label: v.label, chapter: v.chapter }); }
        return out;
    }
    H.add_marker = function (a) {
        var c = getComp(a.comp);
        var mp = a.layer !== undefined ? getLayer(c, a.layer).property("ADBE Marker") : c.markerProperty;
        var m = new MarkerValue(def(a.comment, ""));
        if (has(a, "duration")) m.duration = a.duration;
        if (has(a, "chapter")) m.chapter = a.chapter;
        if (has(a, "url")) m.url = a.url;
        if (has(a, "label")) m.label = a.label;
        mp.setValueAtTime(def(a.time, c.time), m);
        return { markers: listMarkers(mp) };
    };
    H.list_markers = function (a) {
        var c = getComp(a.comp);
        var out = { comp: listMarkers(c.markerProperty) };
        if (a.includeLayers) { out.layers = []; for (var i = 1; i <= c.numLayers; i++) { var lm = listMarkers(c.layer(i).property("ADBE Marker")); if (lm.length) out.layers.push({ layer: c.layer(i).name, markers: lm }); } }
        return out;
    };
    H.remove_markers = function (a) {
        var c = getComp(a.comp);
        var mp = a.layer !== undefined ? getLayer(c, a.layer).property("ADBE Marker") : c.markerProperty;
        var n = 0;
        for (var i = mp.numKeys; i >= 1; i--) {
            if (has(a, "time") && Math.abs(mp.keyTime(i) - a.time) > 1e-3) continue;
            if (has(a, "comment") && mp.keyValue(i).comment !== a.comment) continue;
            mp.removeKey(i); n++;
        }
        return { removed: n };
    };

    // ---- Rendering
    function rqSummary(rq) {
        var st = {};
        st[RQItemStatus.QUEUED] = "queued"; st[RQItemStatus.DONE] = "done"; st[RQItemStatus.RENDERING] = "rendering"; st[RQItemStatus.NEEDS_OUTPUT] = "needs-output";
        st[RQItemStatus.UNQUEUED] = "unqueued"; st[RQItemStatus.ERR_STOPPED] = "error"; st[RQItemStatus.USER_STOPPED] = "stopped"; st[RQItemStatus.WILL_CONTINUE] = "will-continue";
        var out = { rendering: rq.rendering, items: [] };
        for (var i = 1; i <= rq.numItems; i++) {
            var it = rq.item(i);
            var o = { index: i, comp: it.comp.name, status: st[it.status] || String(it.status), outputs: [] };
            for (var j = 1; j <= it.numOutputModules; j++) { var om = it.outputModule(j); o.outputs.push({ file: om.file ? om.file.fsName : null, template: om.name }); }
            out.items.push(o);
        }
        return out;
    }
    // format -> output module templates to try (first match wins), the container AE must
    // end up using, and the file extension that container writes.
    var RQ_FORMATS = {
        "h264": { want: ["H.264 - Match Render Settings - 15 Mbps", "H.264 - Match Render Settings -  15 Mbps", "H.264"], format: "H.264", ext: "mp4" },
        "mp4": { want: ["H.264 - Match Render Settings - 15 Mbps", "H.264 - Match Render Settings -  15 Mbps", "H.264"], format: "H.264", ext: "mp4" },
        "prores": { want: ["High Quality"], format: "QuickTime", ext: "mov", exact: true },
        "mov": { want: ["High Quality"], format: "QuickTime", ext: "mov", exact: true },
        "prores-alpha": { want: ["High Quality with Alpha"], format: "QuickTime", ext: "mov" },
        "lossless": { want: ["Lossless"], format: "AVI", ext: "avi", exact: true },
        "tiff": { want: ["TIFF Sequence with Alpha"], format: "TIFF Sequence", ext: "tif" },
        "png": { want: ["PNG Sequence", "PNG"], format: "PNG Sequence", ext: "png" }
    };
    H.add_to_render_queue = function (a) {
        var c = getComp(a.comp);
        var rq = app.project.renderQueue;
        var it = rq.items.add(c);
        try {
            if (a.renderSettingsTemplate) it.applyTemplate(a.renderSettingsTemplate);
            var om = it.outputModule(1);
            var avail = om.templates;
            var tpl = a.outputModuleTemplate, spec = null;
            if (!tpl && a.format) {
                spec = RQ_FORMATS[lower(a.format)];
                for (var w = 0; w < spec.want.length && !tpl; w++) {
                    for (var k = 0; k < avail.length; k++) {
                        if (spec.exact ? avail[k] === spec.want[w] : avail[k].indexOf(spec.want[w]) === 0) { tpl = avail[k]; break; }
                    }
                }
                if (!tpl) {
                    var shown = [];
                    for (var s2 = 0; s2 < avail.length; s2++) if (!/^_HIDDEN/.test(avail[s2])) shown.push(avail[s2]);
                    fail("No output module template renders '" + a.format + "' in this After Effects", lower(a.format) === "png"
                        ? "AE 2026 has no PNG Sequence template and its Format setting is read-only from scripts. Use render_png_sequence (writes numbered PNGs directly), or save a PNG Sequence output module template in AE and pass outputModuleTemplate. Templates: " + shown.join(", ")
                        : "Templates: " + shown.join(", "));
                }
            }
            if (tpl) om.applyTemplate(tpl);
            if (a.outputPath) {
                // keep [####] frame-number tokens; AE fixes the extension to match the format
                om.file = outFile(a.outputPath);
            }
            if (has(a, "start")) it.timeSpanStart = a.start;
            if (has(a, "duration")) it.timeSpanDuration = a.duration;
            else if (a.workAreaOnly === false) { it.timeSpanStart = 0; it.timeSpanDuration = c.duration; }
            var actualFormat = om.getSettings(GetSettingsFormat.STRING)["Format"];
            var file = om.file ? om.file.fsName : null;
            if (spec) {
                var ext = file ? lower(file.replace(/^.*\./, "")) : null;
                if (actualFormat !== spec.format || (ext && ext !== spec.ext)) {
                    fail("Render queue item would write " + actualFormat + " (" + file + ") instead of " + a.format, "Pass outputModuleTemplate explicitly; available: " + avail.join(", "));
                }
            }
            return { added: { index: rq.numItems, comp: c.name, outputFile: file, template: tpl || om.name, format: actualFormat }, availableOutputTemplates: avail };
        } catch (e) {
            // never leave a half-configured item in the queue
            try { it.remove(); } catch (e2) { }
            throw e;
        }
    };
    H.get_render_queue = function () { return rqSummary(app.project.renderQueue); };
    H.clear_render_queue = function (a) {
        var rq = app.project.renderQueue, n = 0;
        for (var i = rq.numItems; i >= 1; i--) { if (a.onlyDone && rq.item(i).status !== RQItemStatus.DONE) continue; rq.item(i).remove(); n++; }
        return { removed: n };
    };
    // One tool for the whole queue: action render (default, blocking) | list | clear | add
    H.render_queue = function (a) {
        a = a || {};
        var action = def(a.action, "render");
        if (action === "list") return H.get_render_queue(a);
        if (action === "clear") return H.clear_render_queue(a);
        if (action === "add") return H.add_to_render_queue(a);
        var rq = app.project.renderQueue;
        if (!rq.numItems) fail("Render queue is empty", "Use render_queue {action:'add'} or add_to_render_queue first.");
        rq.render();
        return rqSummary(rq);
    };
    // One tool for markers: action add | list | remove
    H.markers = function (a) {
        if (a.action === "add") return H.add_marker(a);
        if (a.action === "remove") return H.remove_markers(a);
        return H.list_markers(a);
    };

    // Frame capture: saves a full-size PNG of the comp at a time. saveFrameToPng is
    // asynchronous (it returns before the file exists), so the server waits for the
    // file and downscales it itself. Nothing temporary is created in the project.
    H.render_frame = function (a) {
        var c = getComp(a.comp);
        var t = def(a.time, c.time);
        if (t < 0 || t > c.duration) fail("Time " + t + "s is outside the comp (0-" + round(c.duration) + "s)");
        var f = new File(a.outputPath);
        if (f.exists) f.remove();
        if (typeof c.saveFrameToPng !== "function") fail("Frame capture is not available in this After Effects version");
        c.saveFrameToPng(t, f);
        return { file: f.fsName, comp: c.name, time: t, width: c.width, height: c.height };
    };

    // Several frames in one round trip (contact sheets). Files are written asynchronously.
    H.render_frames = function (a) {
        var c = getComp(a.comp);
        var times = a.times && a.times.length ? a.times : [c.time];
        if (typeof c.saveFrameToPng !== "function") fail("Frame capture is not available in this After Effects version");
        var clamped = [];
        // Render at a lower comp resolution when only a small preview is needed (2-3x faster).
        // saveFrameToPng is asynchronous, so the server restores the resolution afterwards.
        var factor = 1;
        if (a.maxSize && !a.fullRes) factor = Math.max(1, Math.min(4, Math.floor(Math.max(c.width, c.height) / a.maxSize)));
        var oldRes = c.resolutionFactor;
        if (factor > 1) c.resolutionFactor = [factor, factor];
        var out = [];
        for (var i = 0; i < times.length; i++) {
            var t = Math.max(0, Math.min(times[i], c.duration - c.frameDuration));
            if (Math.abs(t - times[i]) > 1e-6) clamped.push({ requested: times[i], used: round(t, 3) });
            var f = new File(a.names ? a.names[i] : a.outputDir + "/" + a.prefix + "-" + i + ".png");
            if (f.exists) f.remove();
            c.saveFrameToPng(t, f);
            out.push({ time: round(t, 3), file: f.fsName });
        }
        return { clamped: clamped, comp: c.name, compId: c.id, width: c.width, height: c.height, bgColor: [Math.round(c.bgColor[0] * 255), Math.round(c.bgColor[1] * 255), Math.round(c.bgColor[2] * 255)], factor: factor, restoreResolution: factor > 1 ? [oldRes[0], oldRes[1]] : null, frames: out };
    };

    H.restore_resolution = function (a) {
        var c = getComp(a.comp);
        c.resolutionFactor = a.resolution;
        return { comp: c.name, resolutionFactor: c.resolutionFactor };
    };

    // ---- Footage replacement, presets, multi-property reads, Essential Graphics
    H.replace_footage = function (a) {
        var it = findItem(a.item);
        if (!it || !(it instanceof FootageItem) || it.mainSource instanceof SolidSource) fail("Footage item not found: " + a.item, "Use list_project_items type:'footage' to find ids.");
        var f = new File(a.file);
        if (!f.exists) fail("File not found: " + a.file);
        var oldFile = it.file ? it.file.fsName : null;
        if (a.sequence) it.replaceWithSequence(f, !!a.forceAlphabetical);
        else it.replace(f);
        if (a.name) it.name = a.name;
        var users = [];
        for (var i = 0; i < it.usedIn.length && users.length < 20; i++) users.push(it.usedIn[i].name);
        return { id: it.id, name: it.name, file: it.file ? it.file.fsName : null, previousFile: oldFile, usedInComps: it.usedIn.length, comps: users, missing: it.footageMissing };
    };

    function presetRoots() {
        var year = parseInt(app.version, 10) + 2000;
        var roots = [];
        var user = new Folder(Folder.myDocuments.fsName + "/Adobe/After Effects " + year + "/User Presets");
        if (user.exists) roots.push({ kind: "user", folder: user });
        try { var appP = new Folder(Folder.appPackage.fsName + "/Presets"); if (appP.exists) roots.push({ kind: "app", folder: appP }); } catch (e) { }
        return roots;
    }
    H.list_presets = function (a) {
        var q = a.query ? lower(a.query) : null, lim = def(a.limit, 200), out = [], total = 0;
        var roots = presetRoots();
        function walk(folder, base, kind, depth) {
            if (depth > 6) return;
            var items = folder.getFiles();
            for (var i = 0; i < items.length; i++) {
                var f = items[i];
                if (f instanceof Folder) { walk(f, base, kind, depth + 1); continue; }
                if (!/\.ffx$/i.test(f.name)) continue;
                var name = decodeURI(f.name).replace(/\.ffx$/i, "");
                var rel = decodeURI(f.parent.fsName.substr(base.length)).replace(/^[\\\/]+/, "").replace(/\\/g, "/");
                if (q && lower(name).indexOf(q) < 0 && lower(rel).indexOf(q) < 0) continue;
                if (a.source && a.source !== kind) continue;
                total++;
                if (out.length < lim) out.push({ name: name, category: rel, source: kind, path: f.fsName });
            }
        }
        for (var r = 0; r < roots.length; r++) walk(roots[r].folder, roots[r].folder.fsName, roots[r].kind, 0);
        var rootsOut = [];
        for (r = 0; r < roots.length; r++) rootsOut.push({ source: roots[r].kind, folder: roots[r].folder.fsName });
        return { count: out.length, total: total, truncated: total > out.length, roots: rootsOut, presets: out };
    };

    H.get_properties_at_time = function (a) {
        var c = getComp(a.comp);
        var t = def(a.time, c.time);
        var out = [];
        for (var i = 0; i < a.requests.length; i++) {
            var rq = a.requests[i];
            var entry = { layer: rq.layer, values: {} };
            try {
                var l = getLayer(c, rq.layer);
                entry.layer = l.name;
                for (var j = 0; j < rq.properties.length; j++) {
                    var path = rq.properties[j];
                    try {
                        var p = resolveProp(l, path);
                        entry.values[path] = isProperty(p) ? serValue(p.valueAtTime(t, a.preExpression === true)) : "(group)";
                    } catch (pe) { entry.values[path] = { error: String(pe).replace(/^Error: /, "") }; }
                }
            } catch (le) { entry.error = String(le).replace(/^Error: /, ""); }
            out.push(entry);
        }
        return { comp: c.name, time: round(t, 4), results: out };
    };

    function overridesOf(layer) {
        var ov = null;
        try { ov = layer.property("ADBE Layer Overrides"); } catch (e) { }
        if (!ov) fail("Layer '" + layer.name + "' has no Essential Properties", "Use a layer whose source is a comp with Essential Graphics controllers.");
        return ov;
    }
    function listOverrides(group, prefix, out) {
        for (var i = 1; i <= group.numProperties; i++) {
            var p = group.property(i);
            var name = prefix ? prefix + "/" + p.name : p.name;
            if (isProperty(p)) {
                var o = { name: name, matchName: p.matchName };
                try { if (p.propertyValueType !== PropertyValueType.NO_VALUE) o.value = serValue(p.value); } catch (e) { }
                out.push(o);
            } else listOverrides(p, name, out);
        }
        return out;
    }
    H.list_essential_properties = function (a) {
        if (a.layer !== undefined) {
            var c = getComp(a.comp);
            var l = getLayer(c, a.layer);
            return { comp: c.name, layer: l.name, source: l.source ? l.source.name : null, properties: listOverrides(overridesOf(l), "", []) };
        }
        var src = getComp(a.comp);
        var names = [];
        for (var i = 1; i <= src.motionGraphicsTemplateControllerCount; i++) names.push({ index: i, name: src.getMotionGraphicsTemplateControllerName(i) });
        return { comp: src.name, templateName: src.motionGraphicsTemplateName || null, controllers: names };
    };
    H.set_essential_property = function (a) {
        var c = getComp(a.comp);
        var l = getLayer(c, a.layer);
        var ov = overridesOf(l);
        var p = typeof a.property === "number" ? ov.property(a.property) : resolveProp(ov, a.property);
        if (!p || !isProperty(p)) fail("Essential property '" + a.property + "' not found on '" + l.name + "'", "Properties: " + (function () { var n = []; var all = listOverrides(ov, "", []); for (var i = 0; i < all.length && i < 10; i++) n.push(all[i].name); return n.join(", "); })());
        if (has(a, "time")) p.setValueAtTime(a.time, coerce(p, a.value)); else p.setValue(coerce(p, a.value));
        return { layer: l.name, property: p.name, value: serValue(p.value) };
    };
    H.add_to_essential_graphics = function (a) {
        var t = target(a);
        var p = resolveProp(t.layer, a.property);
        if (!isProperty(p) || !p.canAddToMotionGraphicsTemplate(t.comp)) fail("'" + a.property + "' cannot be added to Essential Graphics", "Supported: most transform, effect, text and color properties.");
        var ok = a.name ? p.addToMotionGraphicsTemplateAs(t.comp, a.name) : p.addToMotionGraphicsTemplate(t.comp);
        if (a.templateName) t.comp.motionGraphicsTemplateName = a.templateName;
        var names = [], index = null, want = a.name || p.name;
        // controller indices do NOT follow the order of creation: look the new one up by name
        for (var i = 1; i <= t.comp.motionGraphicsTemplateControllerCount; i++) {
            var nm = t.comp.getMotionGraphicsTemplateControllerName(i);
            names.push(nm);
            if (nm === want) index = i;
        }
        return { added: ok !== false, comp: t.comp.name, name: want, index: index, templateName: t.comp.motionGraphicsTemplateName || null, controllers: names };
    };

    // several Essential Properties of one instance in one call: values {name: value}
    H.set_essential_properties = function (a) {
        var c = getComp(a.comp);
        var l = getLayer(c, a.layer);
        var ov = overridesOf(l), set = [], errors = [];
        for (var k in a.values) {
            if (!a.values.hasOwnProperty(k)) continue;
            try {
                var p = resolveProp(ov, k);
                if (!isProperty(p)) throw new Error("not a property");
                p.setValue(coerce(p, a.values[k]));
                set.push(p.name);
            } catch (e) { errors.push(k + ": " + String(e).replace(/^Error: /, "")); }
        }
        return { layer: l.name, set: set, errors: errors };
    };

    // N instances of a template comp in another comp, each with its own values
    H.instantiate_template = function (a) {
        var tpl = getComp(a.template), into = getComp(a.into);
        if (tpl === into) fail("A template cannot be placed inside itself");
        var out = [];
        for (var i = 0; i < a.items.length; i++) {
            var it = a.items[i];
            var l = into.layers.add(tpl);
            if (it.name) l.name = it.name;
            if (it.position) { var pp = l.property("ADBE Transform Group").property("ADBE Position"); pp.setValue(coerce(pp, it.position)); }
            if (has(it, "startTime")) l.startTime = it.startTime;
            var r = { index: l.index, id: l.id, name: l.name, set: [], errors: [] };
            if (it.values) {
                var sv = H.set_essential_properties({ comp: into.id, layer: "id:" + l.id, values: it.values });
                r.set = sv.set; r.errors = sv.errors;
            }
            out.push(r);
        }
        return { template: tpl.name, into: into.name, instances: out };
    };

    // .mogrt export: AE writes <folder>/<template name>.mogrt asynchronously and the comp
    // object is invalid afterwards, so the server waits for the file.
    H.export_mogrt = function (a) {
        var c = getComp(a.comp), id = c.id;
        if (!c.motionGraphicsTemplateControllerCount) fail("Comp '" + c.name + "' has no Essential Graphics controllers", "Add some with add_to_essential_graphics first.");
        var p = String(a.path).replace(/\\/g, "/");
        var folder = p, name = c.motionGraphicsTemplateName || c.name;
        if (/\.mogrt$/i.test(p)) { folder = p.replace(/\/[^\/]*$/, ""); name = p.replace(/^.*\//, "").replace(/\.mogrt$/i, ""); }
        if (!c.motionGraphicsTemplateName || /\.mogrt$/i.test(p)) c.motionGraphicsTemplateName = name;
        var dir = new Folder(folder);
        if (!dir.exists) dir.create();
        var target = new File(folder + "/" + name + ".mogrt");
        if (target.exists && !a.overwrite) fail("File already exists: " + target.fsName, "Pass overwrite:true to replace it.");
        var ok = c.exportAsMotionGraphicsTemplate(!!a.overwrite || !target.exists, folder);
        return { ok: ok !== false, comp: getComp(id).name, file: target.fsName };
    };

    // ---- Misc
    H.list_fonts = function (a) {
        var out = [];
        var q = a.query ? lower(a.query) : null;
        try {
            var all = app.fonts.allFonts;
            for (var i = 0; i < all.length; i++) {
                var fam = all[i];
                for (var j = 0; j < fam.length; j++) {
                    var f = fam[j];
                    if (q && lower(f.familyName).indexOf(q) < 0 && lower(f.postScriptName).indexOf(q) < 0) continue;
                    out.push({ family: f.familyName, style: f.styleName, postScriptName: f.postScriptName });
                    if (out.length >= def(a.limit, 100)) return { count: out.length, truncated: true, fonts: out };
                }
            }
        } catch (e) { fail("Font listing requires After Effects 2024 or newer (" + e.toString() + ")"); }
        return { count: out.length, fonts: out };
    };

    H.get_selection = function () {
        var c = getComp(null, true);
        if (!c) return { comp: null, layers: [], properties: [] };
        var out = { comp: c.name, time: round(c.time), layers: [], properties: [] };
        for (var i = 0; i < c.selectedLayers.length; i++) out.layers.push(layerSummary(c.selectedLayers[i]));
        try { for (var j = 0; j < c.selectedProperties.length; j++) out.properties.push(propInfo(c.selectedProperties[j], false)); } catch (e) { }
        return out;
    };

    H.select_layers = function (a) {
        var c = getComp(a.comp);
        for (var i = 1; i <= c.numLayers; i++) c.layer(i).selected = false;
        var layers = a.layers && a.layers.length ? getLayers(c, a.layers) : [];
        for (var j = 0; j < layers.length; j++) layers[j].selected = true;
        try { c.openInViewer(); } catch (e) { }
        return { selected: layers.length };
    };

    H.undo = function (a) {
        var n = def(a.steps, 1), ids = { undo: 16, redo: 2035 };
        var id = ids[def(a.action, "undo")];
        // Edit > Undo is routed to the active panel; a text field or palette with focus
        // can swallow it. Give focus to the viewer (or the project) first.
        var focused = null;
        try { if (app.activeViewer) { app.activeViewer.setActive(); focused = "viewer"; } } catch (e) { }
        for (var i = 0; i < n; i++) app.executeCommand(id);
        return { done: a.action || "undo", steps: n, focused: focused };
    };

    // which of these layer ids still exist (used to verify an undo)
    H.layers_exist = function (a) {
        var out = [];
        for (var i = 0; i < a.ids.length; i++) {
            try { if (app.project.layerByID(a.ids[i])) out.push(a.ids[i]); } catch (e) { }
        }
        return { existing: out };
    };

    H.execute_menu_command = function (a) {
        var id = a.commandId;
        if (!id && a.menuName) id = app.findMenuCommandId(a.menuName);
        if (!id) fail("Menu command not found: " + a.menuName);
        app.executeCommand(id);
        return { executed: id };
    };

    H.run_extendscript = function (a) {
        // The code runs inside a function; use `return` to send a value back.
        var fn;
        try { fn = new Function("AEMCP", "args", a.code); }
        catch (se) {
            fail("Syntax error in your ExtendScript: " + String(se).replace(/^\w*Error: /, "") + (se.line ? " (line " + Math.max(1, se.line - 1) + ")" : ""),
                "The code is the BODY of an ES3 function: no let/const, arrow functions, template literals or JSON (use AEMCP.JSON). Use 'return' to send a value back.");
        }
        var v;
        try { v = fn(A, def(a.args, {})); }
        catch (re) { var e2 = new Error(String(re).replace(/^Error: /, "") + (re.line ? " (line " + Math.max(1, re.line - 1) + " of your code)" : "")); e2.aeHint = re.aeHint; throw e2; }
        return { result: serDeep(v, 0) };
    };
    function serDeep(v, d) {
        if (d > 6) return "[max depth]";
        if (v === null || v === undefined) return null;
        var t = typeof v;
        if (t === "number" || t === "string" || t === "boolean") return v;
        if (v instanceof Array) { var a = []; for (var i = 0; i < v.length && i < 500; i++) a.push(serDeep(v[i], d + 1)); return a; }
        if (v instanceof CompItem) return compSummary(v);
        if (v instanceof Layer) return layerSummary(v);
        if (v instanceof Property) return propInfo(v, true);
        if (v instanceof TextDocument || v instanceof Shape || v instanceof MarkerValue) return serValue(v);
        if (t === "object") { var o = {}; for (var k in v) { if (v.hasOwnProperty(k)) { try { o[k] = serDeep(v[k], d + 1); } catch (e) { } } } return o; }
        return String(v);
    }

    // A composition open in the viewer redraws after every change, which makes big
    // batches 2-4x slower. Park the viewer on a tiny empty comp, then restore it.
    // A comp shown in a viewer (and its timeline) redraws after every change. Closing
    // that viewer tab (File > Close, command 4, only while the comp viewer is the active
    // panel) makes 150 layer creations ~9x faster; it is reopened afterwards. When the
    // tab cannot be closed safely, a tiny empty comp is shown instead (~3x faster).
    var CLOSE_PANEL = 4;
    function parkViewer() {
        var shown = null, v = null;
        try {
            v = app.activeViewer;
            // setActive() returns undefined in AE 2026: do not use its result
            if (v && v.type === ViewerType.VIEWER_COMPOSITION) { v.setActive(); if (app.project.activeItem instanceof CompItem) shown = app.project.activeItem; }
        } catch (e) { }
        if (!shown) return null;
        try {
            if (app.findMenuCommandId("Close") === CLOSE_PANEL) {
                app.executeCommand(CLOSE_PANEL);
                var now = app.activeViewer;
                if (!now || now.type !== ViewerType.VIEWER_COMPOSITION || app.project.activeItem !== shown) return { shown: shown, tmp: null, closed: true };
            }
        } catch (e2) { }
        var tmp = app.project.items.addComp("__aemcp_parked__", 4, 4, 1, 1, 30);
        tmp.openInViewer();
        return { shown: shown, tmp: tmp, closed: false };
    }
    function unparkViewer(p) {
        if (!p) return;
        try { p.shown.openInViewer(); } catch (e) { }
        if (p.tmp) { try { p.tmp.remove(); } catch (e2) { } }
    }

    var PARKABLE = { precompose_layers: 1, duplicate_composition: 1, sequence_layers: 1, run_extendscript: 1 };

    H.batch = function (a) {
        var out = [], failed = 0, stoppedAt = null, firstHint = null;
        var parked = a.operations.length > 20 && a.parkViewer !== false ? parkViewer() : null;
        A._lean = !a.verbose;
        try {
        for (var i = 0; i < a.operations.length; i++) {
            var op = a.operations[i];
            var h = H[op.tool];
            if (!h || op.tool === "batch") fail("Unknown tool in batch: " + op.tool);
            if (a.operations.length >= 10) A.progress(i, a.operations.length, op.tool);
            try {
                var r = h(def(op.args, {}));
                if (a.verbose) out.push({ index: i, tool: op.tool, ok: true, result: r });
                else {
                    // compact: enough to address what was made (id/name), nothing else
                    var e = { index: i, tool: op.tool, ok: true };
                    if (r && typeof r === "object") {
                        if (r.id !== undefined) e.id = r.id;
                        if (r.name !== undefined) e.name = r.name;
                        if (r.warning) e.warning = r.warning;
                    }
                    out.push(e);
                }
            }
            catch (e) {
                failed++;
                out.push({ index: i, tool: op.tool, ok: false, error: e.toString().replace(/^Error: /, "") });
                if (!firstHint && e.aeHint) firstHint = e.aeHint;
                if (!a.continueOnError) { stoppedAt = i; break; }
            }
        }
        } finally { A._lean = false; unparkViewer(parked); }
        var res = { ok: failed === 0, failed: failed, stoppedAt: stoppedAt, executed: out.length, total: a.operations.length, results: out };
        if (!a.verbose && out.length > 1) {
            var same = true;
            for (var q = 1; q < out.length && same; q++) if (out[q].tool !== out[0].tool) same = false;
            if (same) { res.tool = out[0].tool; for (q = 0; q < out.length; q++) delete out[q].tool; }
        }
        if (firstHint) res.hint = firstHint;
        if (a.operations.length > 20) res.viewer = parked ? (parked.closed ? "tab closed during the batch" : "parked on an empty comp") : "not parked (no comp viewer was active)";
        // atomic: ask the runner to undo the whole batch after its undo group closes
        if (failed && a.atomic) { res.rolledBack = true; A._rollback = true; }
        return res;
    };

    // ---------------------------------------------------------------- runner
    function writeFile(path, text) {
        var tmp = new File(path + ".tmp");
        tmp.encoding = "UTF-8";
        tmp.lineFeed = "Unix";
        if (!tmp.open("w")) throw new Error("Cannot write result file " + path + " (enable 'Allow Scripts to Write Files and Access Network')");
        tmp.write(text);
        tmp.close();
        var dst = new File(path);
        if (dst.exists) dst.remove();
        tmp.rename(dst.name);
    }

    // Long operations report progress through <result>.progress.json; the server polls it.
    A.progress = function (done, total, message) {
        if (!A._progressPath) return;
        try {
            var f = new File(A._progressPath);
            f.encoding = "UTF-8";
            if (f.open("w")) { f.write(JSONX.stringify({ done: done, total: total, message: message })); f.close(); }
        } catch (e) { }
    };

    A.run = function (payloadText, resultPath) {
        A._progressPath = String(resultPath).replace(/\.json$/, ".progress.json");
        var cancel = new File(String(resultPath).replace(/\.json$/, ".cancel"));
        if (cancel.exists) {
            cancel.remove();
            writeFile(resultPath, JSONX.stringify({ ok: false, cancelled: true, error: "Cancelled before it ran" }));
            return false;
        }
        var res;
        var t0 = new Date().getTime();
        var payload = null;
        var undoOpen = false;
        try {
            payload = JSONX.parse(payloadText);
            var h = H[payload.tool];
            if (!h) throw new Error("Unknown tool '" + payload.tool + "'");
            G.AEMCP_LAST_TOOL = payload.tool;
            if (!app.project && payload.tool !== "ping" && payload.tool !== "new_project") app.newProject();
            app.beginSuppressDialogs();
            if (payload.undo !== false) { app.beginUndoGroup("MCP: " + payload.tool); undoOpen = true; }
            var args = payload.args || {};
            // heavy single tools can opt in to parking the viewer (batch handles it itself)
            var parked = args.parkViewer === true && PARKABLE[payload.tool] ? parkViewer() : null;
            var data;
            try { data = h(args); } finally { unparkViewer(parked); }
            res = { ok: true, data: data };
        } catch (e) {
            res = { ok: false, error: e.toString().replace(/^Error: /, ""), hint: e.aeHint, line: e.line };
        }
        if (undoOpen) { try { app.endUndoGroup(); } catch (e2) { } }
        if (A._rollback) {
            A._rollback = false;
            try { app.executeCommand(16); } catch (e4) { if (res.data) res.data.rolledBack = false; }
        }
        try { app.endSuppressDialogs(false); } catch (e3) { }
        res.id = payload ? payload.id : null;
        res.ms = new Date().getTime() - t0;
        // last 20 calls, shown by the status panel (Window > AE MCP Pro.jsx)
        try {
            if (!G.AEMCP_CALLS) G.AEMCP_CALLS = [];
            G.AEMCP_CALLS.unshift({ time: new Date().toTimeString().substr(0, 8), tool: payload ? payload.tool : "?", ms: res.ms, ok: res.ok });
            if (G.AEMCP_CALLS.length > 20) G.AEMCP_CALLS.length = 20;
        } catch (eC) { }
        writeFile(resultPath, JSONX.stringify(res));
        return res.ok;
    };

    G.AEMCP = A;
})($.global);
