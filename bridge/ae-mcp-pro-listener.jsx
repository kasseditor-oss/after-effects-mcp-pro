/*
 * AE MCP Pro - background listener.
 *
 * Installed into After Effects' user "Scripts/Startup" folder, so it starts with
 * After Effects. No panel has to be opened. It polls a queue folder and runs the
 * command scripts written by the MCP server, one at a time, on AE's main thread.
 *
 * Queue folder: <Folder.userData>/ae-mcp-pro/queue  (Windows: %APPDATA%\ae-mcp-pro)
 */
(function () {
    var G = $.global;
    var VERSION = "2.0.1";
    if (G.AEMCP_LISTENER && G.AEMCP_LISTENER.version === VERSION && G.AEMCP_LISTENER.taskId) return;
    if (G.AEMCP_LISTENER && G.AEMCP_LISTENER.taskId) { try { app.cancelTask(G.AEMCP_LISTENER.taskId); } catch (e) { } }

    var base = Folder.userData.fsName + "/ae-mcp-pro";
    function ensure(p) { var f = new Folder(p); if (!f.exists) f.create(); return f; }
    ensure(base); ensure(base + "/queue"); ensure(base + "/results");

    var L = {
        version: VERSION,
        base: base,
        paused: false,
        busy: false,
        lastBeat: 0,
        executed: 0,
        log: [],
        current: null
    };

    function now() { return new Date().getTime(); }

    function writeText(path, text) {
        var f = new File(path);
        f.encoding = "UTF-8";
        if (f.open("w")) { f.write(text); f.close(); return true; }
        return false;
    }

    L.beat = function () {
        var t = now();
        if (t - L.lastBeat < 1000) return;
        L.lastBeat = t;
        var proj = "";
        try { proj = app.project && app.project.file ? app.project.file.fsName.replace(/\\/g, "/").replace(/"/g, "'") : ""; } catch (e) { }
        writeText(base + "/heartbeat.json", "{\"time\":" + t + ",\"version\":\"" + VERSION + "\",\"ae\":\"" + app.version + "\",\"paused\":" + L.paused + ",\"executed\":" + L.executed + ",\"project\":\"" + proj + "\"}");
    };

    L.push = function (msg) {
        L.log.unshift(new Date().toTimeString().substr(0, 8) + "  " + msg);
        if (L.log.length > 60) L.log.length = 60;
        if (L.onLog) { try { L.onLog(); } catch (e) { } }
    };

    L.tick = function () {
        if (L.busy) return;
        L.busy = true;
        try {
            L.beat();
            if (!L.paused) {
                var files = new Folder(base + "/queue").getFiles("*.jsx");
                if (files && files.length) {
                    files.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
                    var f = files[0];
                    var id = f.name.replace(/\.jsx$/, "").replace(/^\d+-/, "");
                    var running = new File(f.fsName + ".run");
                    if (running.exists) running.remove();
                    if (f.rename(f.name + ".run")) {
                        L.current = id;
                        var t0 = now();
                        // Antivirus/indexers can hold a just-renamed file for a few ms: retry I/O errors.
                        var attempt = 0, err = null;
                        while (true) {
                            try { $.evalFile(running); err = null; break; }
                            catch (e) {
                                err = e;
                                if (attempt < 2 && /IOError|I\/O error/i.test(String(e))) { attempt++; L.ioRetries = (L.ioRetries || 0) + 1; $.sleep(50); continue; }
                                break;
                            }
                        }
                        if (err) {
                            writeText(base + "/results/" + id + ".json", "{\"ok\":false,\"id\":\"" + id + "\",\"error\":\"Script error: " + String(err).replace(/\\/g, "/").replace(/"/g, "'").replace(/[\r\n]+/g, " ") + "\"}");
                        }
                        running.remove();
                        L.executed++;
                        L.current = null;
                        var label = "";
                        try { label = G.AEMCP_LAST_TOOL || ""; } catch (e2) { }
                        L.push((label || id) + "  (" + (now() - t0) + " ms)");
                    }
                }
            }
        } catch (e) {
            L.push("listener error: " + e.toString());
        }
        L.busy = false;
    };

    G.AEMCP_LISTENER = L;
    L.taskId = app.scheduleTask("$.global.AEMCP_LISTENER.tick()", 120, true);
    L.push("listener " + VERSION + " started");
    L.lastBeat = 0;
    L.beat();
})();
