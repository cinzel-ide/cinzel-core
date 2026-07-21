# Cinzel Core

O motor de IA do **Cinzel** — uma extensão para o editor (o fork do VS Code), construída de raiz.

Arquitetura deliberada:

- **`src/core/`** — lógica editor-agnóstica (providers, streaming). Zero imports de `vscode`.
  É o embrião do SDK: reutilizável fora do editor.
- **`src/chat/`, `src/extension.ts`** — o adaptador ao VS Code (a vista de chat, comandos).

## Segurança da chave

A chave de API vive no **SecretStorage** do VS Code (keychain do SO), nunca em texto simples.
Comando: *Cinzel: Definir chave de API…*

## Providers

Qualquer endpoint compatível com OpenAI, via `cinzel.baseUrl` (default: Groq, tier gratuito).
Groq, OpenAI, OpenRouter, DeepSeek, Ollama/LM Studio (local).

## Desenvolver

```bash
npm install
npm run compile          # esbuild -> out/extension.js
npm run typecheck        # tsc --noEmit

# correr no fork Cinzel (ou em qualquer VS Code):
code --extensionDevelopmentPath=$(pwd)
```
