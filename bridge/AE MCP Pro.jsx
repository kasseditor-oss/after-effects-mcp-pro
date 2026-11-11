/*
 * AE MCP Pro - status panel (optional).
 * Window > AE MCP Pro.jsx. Shows whether Claude is connected, lets you pause
 * the bridge, and lists the last commands Claude ran. The bridge itself runs
 * from the Startup listener, so this panel can stay closed.
 */
(function (thisObj) {
    var G = $.global;
    if (!G.AEMCP_LISTENER) {
        var listener = new File(Folder.userData.fsName + "/ae-mcp-pro/ae-mcp-pro-listener.jsx");
        if (listener.exists) $.evalFile(listener);
    }
    var L = G.AEMCP_LISTENER;

    var win = (thisObj instanceof Panel) ? thisObj : new Window("palette", "AE MCP Pro", undefined, { resizeable: true });
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
    var list = win.add("listbox", undefined, [], { multiselect: false });
    list.preferredSize = [320, 220];
    list.alignment = ["fill", "fill"];

    var row = win.add("group");
    var pauseBtn = row.add("button", undefined, "Pause");
    var restartBtn = row.add("button", undefined, "Restart bridge");

    function paint() {
        L = G.AEMCP_LISTENER;
        var ok = !!(L && L.taskId);
        var col = !ok ? [0.85, 0.25, 0.25, 1] : (L.paused ? [0.95, 0.7, 0.2, 1] : [0.35, 0.8, 0.45, 1]);
        try { dot.graphics.foregroundColor = dot.graphics.newPen(dot.graphics.PenType.SOLID_COLOR, col, 1); } catch (e) { }
        status.text = !ok ? "Bridge not running" : (L.paused ? "Paused - Claude cannot control AE" : "Ready - Claude can control After Effects");
        info.text = ok ? ("Commands run: " + L.executed + "   v" + L.version) : "Install with: npm run install-ae";
        pauseBtn.text = ok && L.paused ? "Resume" : "Pause";
        list.removeAll();
        if (ok) for (var i = 0; i < L.log.length; i++) list.add("item", L.log[i]);
    }

    pauseBtn.onClick = function () { if (G.AEMCP_LISTENER) { G.AEMCP_LISTENER.paused = !G.AEMCP_LISTENER.paused; G.AEMCP_LISTENER.lastBeat = 0; G.AEMCP_LISTENER.beat(); } paint(); };
    restartBtn.onClick = function () {
        if (G.AEMCP_LISTENER && G.AEMCP_LISTENER.taskId) { try { app.cancelTask(G.AEMCP_LISTENER.taskId); } catch (e) { } }
        G.AEMCP_LISTENER = null;
        var f = new File(Folder.userData.fsName + "/ae-mcp-pro/ae-mcp-pro-listener.jsx");
        if (f.exists) $.evalFile(f);
        if (G.AEMCP_LISTENER) G.AEMCP_LISTENER.onLog = paint;
        paint();
    };
    if (L) L.onLog = paint;

    win.onResizing = win.onResize = function () { this.layout.resize(); };
    paint();
    if (win instanceof Window) { win.center(); win.show(); } else { win.layout.layout(true); }
})(this);
