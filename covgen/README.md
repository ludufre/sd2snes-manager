# covgen

Fonte Go do encoder de capas `.cov` v4 (`internal/cov`), compilado para WebAssembly. É assim que o
Manager converte capas do lado do cliente, gerando bytes idênticos aos do covgen nativo, sem
depender de servidor.

O código mora aqui para que o wasm possa ser reconstruído a partir deste repositório sozinho. Ele
veio do repo `sd2snes-covers`, hoje arquivado, e a única mudança foi o caminho de import do módulo.
As dependências pesadas de desktop (fyne, zenity) não fazem falta no wasm: este módulo depende só de
`golang.org/x/image`, para decodificar bmp e webp.

O módulo ainda carrega `internal/gd`, o encoder da tela de informação `.gd`. O Manager não usa mais
esse caminho (capa, snapshot e prévia da ficha passaram a sair do encoder JS em `bandpal.js` mais
ffmpeg), e o entrypoint wasm não exporta mais `gdEncode`. O pacote continua no repositório com os
testes dele, porque a firmware ainda lê o formato.

## Layout

```
covgen/
├── cmd/covwasm/main.go    # entrypoint wasm, registra globalThis.covgenEncode(...)
├── internal/cov/          # encoder .cov v4 (com testes)
├── internal/gd/           # encoder .gd DirectColor (com testes)
├── build-covwasm.sh       # build para web/public/{covgen.wasm,wasm_exec.js}
├── go.mod / go.sum
└── README.md
```

## Rebuild

```bash
cd covgen
./build-covwasm.sh            # escreve ../web/public/covgen.wasm + wasm_exec.js
# ou: ./build-covwasm.sh /outro/public
```

Precisa do toolchain Go; foi construído e testado com go 1.24 ou mais novo. Os testes rodam com
`go test ./...`.

Uma ressalva importante: o `covgen.wasm` embute o runtime do Go, então o `wasm_exec.js` tem que vir
exatamente da mesma versão do Go que gerou o wasm. O script sempre regenera os dois juntos, e trocar
só um quebra. Reconstruir com um Go mais novo produz bytes diferentes do artefato que está no
repositório, e ambos são válidos; o `web/public/covgen.wasm` commitado é o que foi testado, e só é
substituído quando você roda o script de novo.

## Como o Manager usa

`web/src/app/lib/covwasm.js` carrega `web/public/covgen.wasm` junto com o `wasm_exec.js` e chama o
global que o wasm registra:

- `covgenEncode(imageBytes, opts?)` devolve os bytes do `.cov` v4.
