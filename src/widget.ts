/**
 * Inline activity card (MCP Apps, SEP-1865) that Claude renders under every
 * After Effects tool call: the Ae mark, what is being done, live status, a
 * short summary of the result and any frame previews. This is the same
 * mechanism hosted connectors use to show their own branded card.
 *
 * The page speaks the ui/* postMessage protocol directly (no SDK bundle).
 */
export const WIDGET_URI = "ui://after-effects/activity.html";
export const WIDGET_MIME = "text/html;profile=mcp-app";

/** Portuguese action labels shown in the card. */
export const TOOL_LABELS: Record<string, string> = {
  bridge_status: "Verificando conexão com o After Effects",
  launch_after_effects: "Abrindo o After Effects",
  get_project_info: "Lendo o projeto",
  list_project_items: "Listando itens do projeto",
  save_project: "Salvando o projeto",
  open_project: "Abrindo projeto",
  new_project: "Criando projeto novo",
  import_files: "Importando arquivos",
  create_folder: "Criando pasta",
  replace_footage: "Substituindo footage",
  list_presets: "Listando presets",
  get_properties_at_time: "Lendo propriedades",
  list_essential_properties: "Lendo Essential Graphics",
  set_essential_property: "Ajustando Essential Graphics",
  add_to_essential_graphics: "Adicionando ao Essential Graphics",
  set_essential_properties: "Ajustando Essential Graphics",
  instantiate_template: "Instanciando template",
  export_mogrt: "Exportando .mogrt",
  remove_unused_footage: "Removendo footage sem uso",
  organize_items: "Organizando o projeto",
  modify_item: "Editando item do projeto",
  list_compositions: "Listando composições",
  get_composition: "Lendo a composição",
  create_composition: "Criando composição",
  set_composition_settings: "Ajustando a composição",
  duplicate_composition: "Duplicando composição",
  open_composition: "Abrindo composição",
  precompose_layers: "Pré-compondo layers",
  create_text_layer: "Criando texto",
  create_shape_layer: "Criando shape layer",
  create_solid_layer: "Criando solid",
  create_null_layer: "Criando null",
  create_camera: "Criando câmera",
  create_light: "Criando luz",
  add_item_to_comp: "Adicionando à composição",
  list_layers: "Listando layers",
  get_layer_details: "Inspecionando layer",
  set_layer_properties: "Ajustando layers",
  duplicate_layer: "Duplicando layer",
  delete_layers: "Removendo layers",
  reorder_layer: "Reordenando layer",
  set_parent: "Fazendo parent",
  set_track_matte: "Aplicando track matte",
  split_layer: "Dividindo layer",
  sequence_layers: "Sequenciando layers",
  align_layers: "Alinhando layers",
  set_text: "Editando texto",
  get_property: "Lendo propriedade",
  set_property: "Ajustando propriedade",
  set_keyframes: "Criando keyframes",
  remove_keyframes: "Removendo keyframes",
  set_expression: "Aplicando expressão",
  check_expressions: "Verificando expressões",
  animate_layer: "Animando layer",
  add_text_animator: "Criando animador de texto",
  keyframes_from_markers: "Keyframes nos marcadores",
  position_along_path: "Animando ao longo do caminho",
  apply_expression_preset: "Aplicando expressão pronta",
  list_available_effects: "Procurando efeitos",
  apply_effect: "Aplicando efeito",
  get_layer_effects: "Lendo efeitos",
  modify_effect: "Ajustando efeito",
  apply_effect_template: "Aplicando look",
  apply_preset_file: "Aplicando preset .ffx",
  add_mask: "Criando máscara",
  remove_masks: "Removendo máscaras",
  add_marker: "Adicionando marcador",
  markers: "Marcadores",
  audio_to_keyframes: "Convertendo áudio em keyframes",
  markers_from_audio_peaks: "Marcando batidas do áudio",
  list_markers: "Listando marcadores",
  remove_markers: "Removendo marcadores",
  preview_frame: "Renderizando preview",
  preview_contact_sheet: "Renderizando frames",
  add_to_render_queue: "Adicionando à fila de render",
  get_render_queue: "Lendo fila de render",
  clear_render_queue: "Limpando fila de render",
  render_queue: "Renderizando",
  render_in_background: "Render em segundo plano",
  render_png_sequence: "Renderizando sequência PNG",
  get_background_render: "Progresso do render",
  list_fonts: "Listando fontes",
  get_selection: "Lendo a seleção",
  select_layers: "Selecionando layers",
  undo: "Desfazendo",
  begin_undo_group: "Iniciando grupo de undo",
  end_undo_group: "Fechando grupo de undo",
  execute_menu_command: "Executando comando de menu",
  run_extendscript: "Executando ExtendScript",
  batch: "Executando lote de operações",
};

export function widgetHtml(iconDataUri: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>After Effects</title>
<style>
:root{--bg:#ffffff;--fg:#1d1d26;--muted:#6a6a78;--line:#e4e4ee;--chip:#f0f0f8;--ok:#13a36b;--run:#7b6cff;--err:#d92d48;--acc:#9999ff;}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#1e1e24;--fg:#ececf3;--muted:#a1a1b0;--line:#32323c;--chip:#2a2a33;}}
:root[data-theme=dark]{--bg:#1e1e24;--fg:#ececf3;--muted:#a1a1b0;--line:#32323c;--chip:#2a2a33;}
*{box-sizing:border-box}html,body{margin:0;background:transparent;color:var(--fg);font:13px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.card{border:1px solid var(--line);border-radius:12px;padding:10px 12px;background:var(--bg)}
.row{display:flex;align-items:center;gap:10px;min-width:0}
.icon{width:28px;height:28px;border-radius:7px;flex:none}
.txt{min-width:0}.t{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sub{color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chip{margin-left:auto;font-size:11.5px;padding:3px 9px;border-radius:999px;background:var(--chip);display:flex;align-items:center;gap:6px;white-space:nowrap;flex:none}
.dot{width:7px;height:7px;border-radius:50%;background:var(--run)}
.run .dot{animation:p 1s ease-in-out infinite}@keyframes p{50%{opacity:.25}}
.ok .dot{background:var(--ok)}.err .dot{background:var(--err)}
.sum{margin-top:8px;font-size:12.5px;white-space:pre-wrap;word-break:break-word;max-height:120px;overflow:auto}
.sum:empty{display:none}.err-text{color:var(--err)}
.imgs{display:flex;gap:6px;margin-top:8px;overflow-x:auto}.imgs:empty{display:none}
.imgs img{max-height:220px;max-width:100%;border-radius:8px;border:1px solid var(--line);background:#000}
.bar{height:2px;margin-top:9px;border-radius:2px;background:linear-gradient(90deg,transparent,var(--acc),transparent);background-size:200% 100%;animation:s 1.2s linear infinite}
@keyframes s{from{background-position:200% 0}to{background-position:-200% 0}}
.done .bar{display:none}
@media (prefers-reduced-motion:reduce){.bar,.run .dot{animation:none}}
</style></head>
<body>
<div class="card" id="card">
  <div class="row">
    <img class="icon" src="${iconDataUri}" alt="After Effects">
    <div class="txt"><div class="t">After Effects <span class="sub" id="tool"></span></div><div class="sub" id="what">Conectando…</div></div>
    <div class="chip run" id="chip"><span class="dot"></span><span id="state">Executando</span></div>
  </div>
  <div class="bar"></div>
  <div class="sum" id="sum"></div>
  <div class="imgs" id="imgs"></div>
</div>
<script>
(function(){
  var nextId=1, pending={}, started=Date.now(), toolName="";
  var LABELS=${JSON.stringify(TOOL_LABELS)};
  function $(id){return document.getElementById(id)}
  function send(m){ try{ window.parent.postMessage(m,"*"); }catch(e){} }
  function request(method,params){ var id=nextId++; send({jsonrpc:"2.0",id:id,method:method,params:params||{}}); return new Promise(function(r){pending[id]=r;}); }
  function notify(method,params){ send({jsonrpc:"2.0",method:method,params:params||{}}); }
  function size(){ var c=$("card"); notify("ui/notifications/size-changed",{width:Math.ceil(c.scrollWidth),height:Math.ceil(c.getBoundingClientRect().height)+2}); }
  function ctx(c){ if(!c) return; if(c.theme) document.documentElement.setAttribute("data-theme",c.theme); if(c.toolInfo&&c.toolInfo.tool) setTool(c.toolInfo.tool.name,c.toolInfo.tool.title); }
  function setTool(name,title){ if(!name) return; toolName=name; $("tool").textContent="· "+name; $("what").textContent=LABELS[name]||title||name.replace(/_/g," "); size(); }
  function setState(kind,text){ $("chip").className="chip "+kind; $("state").textContent=text; if(kind!=="run") $("card").className="card done"; size(); }
  function brief(v,depth){
    depth=depth||0;
    if(v===null||v===undefined) return "";
    if(typeof v!=="object") return String(v);
    if(Array.isArray(v)) return v.length+" item"+(v.length===1?"":"s");
    var out=[], keys=Object.keys(v);
    for(var i=0;i<keys.length&&out.length<6;i++){
      var k=keys[i], x=v[k];
      if(x===null||x===undefined||x===""||k==="id") continue;
      if(Array.isArray(x)){ if(x.length||k!=="errors") out.push(k+": "+x.length); }
      else if(typeof x==="object"){ if(depth<1){ var b=brief(x,depth+1); if(b) out.push(k+" → "+b.replace(/\\n/g,", ")); } }
      else if(String(x).length<80) out.push(k+": "+x);
    }
    return out.join(depth?", ":"\\n");
  }
  function onInput(p){
    var a=(p&&p.arguments)||{};
    var hint=a.name||a.text||a.preset||a.effect||a.template||a.comp||a.path||"";
    if(hint&&typeof hint!=="object"){ hint=String(hint); if(hint.length>40) hint=hint.slice(0,40)+"…"; $("what").textContent=(LABELS[toolName]||$("what").textContent)+" — "+hint.split(/[\\\\/]/).pop(); }
    size();
  }
  function onResult(r){
    r=r||{};
    var secs=((Date.now()-started)/1000).toFixed(1)+"s";
    var summary=(r._meta||{})["after-effects/summary"], text="", imgs=$("imgs");
    imgs.innerHTML="";
    (r.content||[]).forEach(function(c){
      if(c.type==="text"&&!text) text=c.text;
      if(c.type==="image"&&c.data){ var im=document.createElement("img"); im.src="data:"+(c.mimeType||"image/png")+";base64,"+c.data; im.onload=size; imgs.appendChild(im); }
    });
    if(r.isError){
      setState("err","Erro · "+secs);
      var s=document.createElement("span"); s.className="err-text"; s.textContent=text.replace(/^Error: /,"").slice(0,600);
      $("sum").innerHTML=""; $("sum").appendChild(s);
    } else {
      setState("ok","Concluído · "+secs);
      if(!summary){ try{ summary=brief(JSON.parse(text)); }catch(e){ summary=text.slice(0,300); } }
      $("sum").textContent=summary||"";
    }
    size();
  }
  window.addEventListener("message",function(e){
    var m=e.data; if(!m||m.jsonrpc!=="2.0") return;
    if(m.id!==undefined&&m.id!==null&&!m.method){ var cb=pending[m.id]; if(cb){ delete pending[m.id]; cb(m.result||{}); } return; }
    switch(m.method){
      case "ui/notifications/tool-input": onInput(m.params); break;
      case "ui/notifications/tool-result": onResult(m.params); break;
      case "ui/notifications/tool-cancelled": setState("err","Cancelado"); break;
      case "ui/notifications/host-context-changed": ctx(m.params); break;
    }
    if(m.method&&m.id!==undefined&&m.id!==null) send({jsonrpc:"2.0",id:m.id,result:{}});
  });
  request("ui/initialize",{appInfo:{name:"after-effects-activity",version:"1.0.0"},appCapabilities:{availableDisplayModes:["inline"]},protocolVersion:"2026-01-26"}).then(function(res){
    ctx(res&&res.hostContext);
    if(!toolName) $("what").textContent="Trabalhando no After Effects…";
    notify("ui/notifications/initialized",{});
    size();
  });
  if(window.ResizeObserver) new ResizeObserver(size).observe(document.body);
})();
</script>
</body></html>`;
}
