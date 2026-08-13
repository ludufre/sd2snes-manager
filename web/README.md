# web

O app Angular do sd2snes+ Manager. A visão geral, o que ele faz e como o cartão é organizado estão
no [README da raiz](../README.md); aqui ficam só os comandos do dia a dia.

```bash
pnpm install
pnpm start     # ng serve, http://localhost:4200
pnpm test      # Vitest
pnpm build     # ng build
```

O dev server precisa do `proxy.config.json` para falar com a GameDB sem esbarrar em CORS, e ele já
entra pelo `pnpm start`. A File System Access API exige contexto seguro, então use `localhost` e um
navegador Chromium.

Para a build de produção use o `../build.sh`, que cuida do base-href, do staging dos assets do
ffmpeg e do pdf.js e do `version.json`. O `ng build` cru não faz nada disso.
