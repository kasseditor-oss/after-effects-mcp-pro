# Relatório final da rodada 3 (melhorias v3): after-effects-mcp-pro 2.2.0

Data: 12/11/2026. Branch `fix/qa-round-3`. Servidor **2.2.0**, listener **2.0.4**, After Effects 26.5 (Windows 11).

Todo o trabalho foi feito em projetos temporários (`%TEMP%\aemcp-*`) e em comps "QA " / "MCP Test". Nenhum projeto do usuário foi aberto ou salvo. Nada foi publicado no npm, na Glama, na Smithery nem no registry de MCP.

## 1. Testes antes e depois

| | Antes (início da rodada, 2.1.0) | Depois (2.2.0) |
|---|---|---|
| `npm test` (unit, sem AE) | 21 de 21 | 33 de 33 |
| `npm run test:live` | 148 de 149 (86 ferramentas) | 390 de 390 (140 ferramentas e variantes) |
| `npm run test:stress` | 11 cenários, 0 inesperados | 16 cenários. AE recém-aberto: 0 inesperados. Depois de horas de testes na mesma sessão: 1 inesperado (item 9, veja abaixo) |

### Itens 9, 10 e 12

| Item | Antes | Depois |
|---|---|---|
| 9. Comp aberta e batch de 150 `create_shape_layer` | 11,6 s (77 ms por operação) | **1,9 s** com o AE recém-aberto (13 ms por operação; o batch de 100 levou 1,1 a 1,4 s). Depois de horas de testes na mesma sessão, deu de 3,5 a 5,0 s; nesse estado, criar as 150 shapes por script puro, sem o MCP, também passa de 2 s. Nas mesmas condições, o handler custa cerca de 1,35 vez o script puro. |
| 10. Resposta do batch de 150 creates | 56 KB | 7,1 KB (`verbose:false` é o padrão) |
| 10. `list_layers` com 150 layers | 45 KB | 7,8 KB com `compact:true` (sem compact: 40 a 51 KB) |
| 12. Contact sheet | 6 frames com `maxSize:1600`: 6412×1804 px, 342 KB | 8 frames sem parâmetros: 1452×408 px (o padrão `sheetMaxSize` é 2048); 12 frames de 1080p: 30 KB em cerca de 1,2 s |

## 2. Tamanho do `tools/list`

| Perfil | Antes | Depois |
|---|---|---|
| `full` | 1,2 MB (79 ferramentas, ícone de 14 KB em cada uma) | 117,7 KB (93 ferramentas) |
| `core` | não existia | 29,4 KB (31 ferramentas) |
| `minimal` | não existia | 7,2 KB (10 ferramentas) |

## 3. As 5 tarefas do QA refeitas

O script cliente chama as ferramentas como um agente faria (`qa-after.mjs`; o resultado está em `qa-after.json`). A contagem inclui o contact sheet e, nas tarefas A1 a A3, uma leitura de conferência.

| Tarefa | Chamadas antes | Chamadas depois | Tempo | Contact sheet | Resultado |
|---|---|---|---|---|---|
| A1 lower third 1080p | 21 | 4 | 5,3 s | `a1-sheet.jpg` | Texto com a fonte e a caixa pedidas, alinhado à esquerda dentro da placa (`anchor: baseline-left`), visível depois do `text-fade-up`, sublinhado com Trim Paths, motion blur |
| A2 kinetic 9:16, 6 palavras | 3 | 4 | 3,2 s | `a2-sheet.jpg` | 6 presets escalonados num único batch; "agora." sem caixa alta forçada |
| A3 logo reveal 3D | 15 | 4 | 4,2 s | `a3-sheet.jpg` | Hexágono com gradiente de cor, glow por layer style, anel com Trim Paths, máscara animada com `modify_mask`, câmera centralizada (POI 960,540,0) com push-in, spot e luz ambiente |
| A4 Essential Graphics 3× | 20 | 5 | 2,0 s | `a4-sheet.jpg` | `instantiate_template` cria as 3 instâncias por nome (Texto, Cor), com emoji, sem confusão de índices |
| A5 import, look e render | 10 | 5 | 102 s (95 s de aerender) | `a5-sheet.jpg` | Vídeo gerado com o ffmpeg, scale de 110 para 100, `cinematic-look`, `vignette-soft`, `blur-in`; render `mp4-h264-high`; o ffprobe mostra h264, 1920×1080, 90 frames |

### Bugs que o QA refeito encontrou (corrigidos no commit `4e919cd`)

- **AE e aerender travavam ao serem iniciados pelo servidor.** Clientes MCP passam um ambiente reduzido (sem `CommonProgramFiles`, `ProgramData`, `windir`...). O AE ficava parado em cerca de 26 MB sem janela (`launch_after_effects`) e o aerender não passava da primeira linha. Agora esses processos recebem o ambiente padrão do Windows (`src/platform/appenv.ts`). Tem teste unit.
- **`threeD`, `blendMode` e `motionBlur` eram ignorados em shapes e textos.** No ExtendScript, essas layers não são `instanceof AVLayer`. Com isso, o "logo reveal 3D" da rodada anterior não era 3D de verdade.
- **`add_layer_style` `drop-shadow` falhava em algumas sessões.** `findMenuCommandId("Drop Shadow")` devolve um id errado no AE 2026; agora os ids fixos são usados primeiro.
- **Caminho `Contents/Shape 1/...`.** Os grupos se chamam "Group 1", mas o caminho natural agora funciona.
- **`render_in_background`** passou a aceitar o id da comp, como as outras ferramentas.

### Durante o fechamento

- **O AE parou de abrir:** "CEP suite couldn't be loaded" ou nenhuma janela. Causa encontrada: os serviços `ASMSvc` e `AASSvc` da Acer estavam com 4,3 milhões de handles vazados. O dono encerrou esses processos, o total caiu para 254 mil handles e o AE voltou a abrir normalmente.
- **`launch_after_effects`** retornava na hora quando o AE estava aberto mas ainda carregando. Corrigido (`6ed2cc2`), com teste.
- **O stress test deixava 1000 sólidos no projeto,** o que deixava os cenários seguintes lentos. Corrigido (`584ca9c`).

## 4. Itens pulados ou feitos de forma parcial

- **11. `new_project` lento:** fechar o projeto em si levou 0,33 s, e `removeUnusedFootage` antes de fechar deixou o processo mais lento, não mais rápido. Ficou só o progresso (heartbeat a cada 2 s).
- **30. `gif`:** o AE não tem módulo de saída GIF e scripts não escolhem preset do Media Encoder (`canQueueInAME` é falso). Devolve um erro claro com a alternativa. **`png-seq`:** não existe template PNG; o caminho é `render_png_sequence`.
- **34. Diálogo do PSD:** a detecção de diálogo modal foi testada com `alert()`; o diálogo de importação de PSD não foi testado (não havia PSD).
- **37. `curves`:** a curva do efeito Curves não é acessível por script, então o template usa Levels (contraste suave). **`glitch-rgb-split`:** o VR Chromatic Aberrations não renderiza em comp comum, então o template usa Channel Blur horizontal em R e B.
- **40. macOS:** **não foi validado** num Mac (não havia um disponível). O CI roda `npm test` em `macos-latest`. Falta testar o que está em `docs/macos-checklist.md`: nome da pasta de preferências e do processo do Beta, `osascript DoScriptFile`, tamanhos do `sips`, live test e render.

## 5. Pronto para publicação (item 41), nada publicado

- `npx after-effects-mcp-pro setup | --help | --version`. O `npm pack` foi instalado numa pasta limpa e o servidor respondeu ao `tools/list` via `npx`.
- `manifest.json` (MCPB 0.3) validado com `mcpb validate`; um `.mcpb` de 3,3 MB foi gerado localmente e não foi anexado a nada.
- `examples/` (`.mcp.json` normal e uma versão restrita), `CONTRIBUTING.md`, templates de issue e PR, `LICENSE`, `glama.json`, `smithery.yaml`, `docs/listing.md` (passos de publicação, só para o dono executar).
- README em inglês com seção em português, `docs/demo.gif` (A3 renderizado) e `docs/tools.md` gerado por `npm run docs`, com checagem no CI.

## 6. Commits da rodada (55)

Veja `git log main..fix/qa-round-3`. Por tema:

- Bugs do QA original (itens 1 a 8 e 13 a 22): `4489ccf`, `4c8c62b`, `a41f191`, `f289083`, `8f1824d`, `10dc910`, `03a51c2`, `d799e03`, `4b47c3e`, `757e352`, `8acb024`, `a365d54`, `61ccb36`, `40d6649`, `aa5b756`, `34295d2`, `aed8fc1`, `bc55c64`
- Desempenho (itens 5, 9, 10, 11, 12): `8d3be0d`, `9398c87`, `1a527e6`, `59b122a`, `7fea78e`, `22cb697`, `63bef93`, `1e38291`
- Recursos (itens 23 a 30 e 36 a 38): `8907cf5`, `8b074e9`, `16502c8`, `28a0ce1`, `f29d223`, `acc484d`, `5cfdbb6`, `21d46bc`, `aee53fc`, `91321b0`, `e13f5d3`
- Segurança e operação (itens 31 a 35): `644de7d`, `b87ea1a`, `961058e`, `6fb966a`, `12abc16`, `29c315e`, `0051aeb`
- Compatibilidade, macOS, distribuição e docs (itens 39 a 42): `48c5e00`, `e157a92`, `db9b858`, `8e5082a`, `d2788c7`
- Testes e versão: `fd9cb66`, `a2262a3`, `6ed2cc2`, `584ca9c`, `194592b`, `4e919cd`, mais o commit deste relatório
