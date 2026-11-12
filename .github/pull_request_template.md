## What changes

<!-- One or two sentences. Link the issue if there is one. -->

## How it was tested

- [ ] `npm run typecheck && npm run check:es3 && npm run build && npm test`
- [ ] `npm run test:live` (After Effects version: ____ , OS: ____ ) - or say why not
- [ ] Visual changes checked with `preview_frame` / `preview_contact_sheet`
- [ ] `npm run docs` (when tools or parameters changed)

## Checklist

- [ ] ExtendScript stays ES3 (no let/const/arrow functions/forEach; no chained `a ? b : c ? d : e`)
- [ ] New parameters are optional (the current interface keeps working)
- [ ] Behaviour changes are in CHANGELOG.md
- [ ] Listener changed: `VERSION` in `bridge/ae-mcp-pro-listener.jsx` and `LISTENER_VERSION` in `src/bridge.ts` bumped
