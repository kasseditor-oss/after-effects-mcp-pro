/*
 * AE MCP Pro - status panel (optional).
 * Window > AE MCP Pro.jsx. Shows whether Claude can control After Effects, the last
 * calls it made, lets you pause the bridge, and turns "start with After Effects" on
 * or off. The bridge itself runs from the Startup listener, so this panel can stay
 * closed.
 */
(function (thisObj) {
    var G = $.global;
    if (!G.AEMCP_LISTENER) {
        var listener = new File(Folder.userData.fsName + "/ae-mcp-pro/ae-mcp-pro-listener.jsx");
        if (listener.exists) $.evalFile(listener);
    }

    var win = (thisObj instanceof Panel) ? thisObj : new Window("palette", "AE MCP Pro", undefined, { resizeable: true });
    G.AEMCP_PANEL = win; // keep a floating palette alive after this script ends
    win.orientation = "column";
    win.alignChildren = ["fill", "top"];
    win.spacing = 6;
    win.margins = 10;

    var head = win.add("group");
    head.orientation = "row";
    var dot = head.add("statictext", undefined, "●");
    var status = head.add("statictext", undefined, "", { truncate: "end" });
    status.alignment = ["fill", "center"];

    var info = win.add("statictext", undefined, "", { truncate: "end" });
    var list = win.add("listbox", undefined, [], { multiselect: false, numberOfColumns: 3, showHeaders: true, columnTitles: ["Time", "Tool", "ms"], columnWidths: [70, 190, 60] });
    list.preferredSize = [340, 240];
    list.alignment = ["fill", "fill"];

    var row = win.add("group");
    var pauseBtn = row.add("button", undefined, "Pause");
    var restartBtn = row.add("button", undefined, "Restart bridge");
    var autoStart = win.add("checkbox", undefined, "Start with After Effects");

    function L() { return G.AEMCP_LISTENER; }

    function paint() {
        var l = L();
        var ok = !!(l && l.taskId);
        var state = !ok ? "stopped" : (l.paused ? "paused" : (l.current ? "busy" : "listening"));
        var col = [0.35, 0.8, 0.45, 1];
        if (state === "stopped") col = [0.85, 0.25, 0.25, 1];
        else if (state === "paused") col = [0.95, 0.7, 0.2, 1];
        else if (state === "busy") col = [0.48, 0.42, 1, 1];
        try { dot.graphics.foregroundColor = dot.graphics.newPen(dot.graphics.PenType.SOLID_COLOR, col, 1); } catch (e) { }
        if (state === "stopped") status.text = "Bridge not running";
        else if (state === "paused") status.text = "Paused - Claude cannot control After Effects";
        else if (state === "busy") status.text = "Busy - running a command from Claude";
        else status.text = "Listening - Claude can control After Effects";
        info.text = ok ? ("Commands run: " + l.executed + "   listener " + l.version) : "Install with: npm run install-ae";
        pauseBtn.text = ok && l.paused ? "Resume" : "Pause";
        pauseBtn.enabled = ok;
        try { autoStart.value = ok ? l.startsWithAE() : false; autoStart.enabled = ok; } catch (e2) { autoStart.enabled = false; }
        // last 20 calls recorded by the runtime: time, tool, duration
        list.removeAll();
        var calls = G.AEMCP_CALLS || [];
        for (var i = 0; i < calls.length && i < 20; i++) {
            var it = list.add("item", calls[i].time);
            it.subItems[0].text = calls[i].tool + (calls[i].ok ? "" : "  (error)");
            it.subItems[1].text = String(calls[i].ms);
        }
    }

    pauseBtn.onClick = function () { var l = L(); if (l) l.setPaused(!l.paused); paint(); };
    autoStart.onClick = function () { var l = L(); if (l) l.setStartsWithAE(autoStart.value); paint(); };
    restartBtn.onClick = function () {
        var l = L();
        if (l && l.taskId) { try { app.cancelTask(l.taskId); } catch (e) { } }
        G.AEMCP_LISTENER = null;
        var f = new File(Folder.userData.fsName + "/ae-mcp-pro/ae-mcp-pro-listener.jsx");
        if (f.exists) $.evalFile(f);
        if (G.AEMCP_LISTENER) G.AEMCP_LISTENER.onLog = paint;
        paint();
    };
    if (L()) L().onLog = paint;

    win.onResizing = win.onResize = function () { this.layout.resize(); };
    paint();
    if (win instanceof Window) { win.center(); win.show(); } else { win.layout.layout(true); }
})(this);
