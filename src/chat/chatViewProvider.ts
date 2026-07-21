import * as vscode from 'vscode';
import { streamChat } from '../core/provider';
import { ChatMessage } from '../core/types';

const API_KEY_SECRET = 'cinzel.apiKey';

/**
 * A vista de chat na barra lateral. Faz a ponte entre o webview (a UI) e o
 * Cinzel Core (`streamChat`). A chave vem do SecretStorage — keychain do SO.
 */
export class CinzelChatViewProvider implements vscode.WebviewViewProvider {

    public static readonly viewType = 'cinzel.chat';

    private view?: vscode.WebviewView;
    private history: ChatMessage[] = [];

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly secrets: vscode.SecretStorage
    ) { }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };
        view.webview.html = this.html(view.webview);
        view.webview.onDidReceiveMessage(async msg => {
            if (msg?.type === 'send' && typeof msg.text === 'string' && msg.text.trim()) {
                await this.handleSend(msg.text.trim());
            }
        });
    }

    clear(): void {
        this.history = [];
        this.view?.webview.postMessage({ type: 'clear' });
    }

    private async handleSend(text: string): Promise<void> {
        const view = this.view;
        if (!view) { return; }

        const apiKey = await this.secrets.get(API_KEY_SECRET);
        if (!apiKey) {
            view.webview.postMessage({
                type: 'error',
                text: 'Sem chave de API. Corre o comando "Cinzel: Definir chave de API…" (⇧⌘P).'
            });
            return;
        }

        const cfg = vscode.workspace.getConfiguration('cinzel');
        const baseUrl = cfg.get<string>('baseUrl', 'https://api.groq.com/openai/v1');
        const model = cfg.get<string>('model', 'openai/gpt-oss-120b');

        this.history.push({ role: 'user', content: text });
        view.webview.postMessage({ type: 'user', text });
        view.webview.postMessage({ type: 'assistant-start' });

        let answer = '';
        try {
            await streamChat(
                [
                    {
                        role: 'system',
                        content: 'És o assistente do Cinzel IDE. Responde em português de Portugal, de forma concisa e técnica. Formata código em blocos markdown.'
                    },
                    ...this.history
                ],
                { baseUrl, apiKey, model },
                delta => {
                    answer += delta;
                    view.webview.postMessage({ type: 'assistant-delta', text: delta });
                }
            );
            this.history.push({ role: 'assistant', content: answer });
            view.webview.postMessage({ type: 'assistant-end' });
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            view.webview.postMessage({ type: 'error', text: message });
        }
    }

    private html(webview: vscode.Webview): string {
        const nonce = getNonce();
        const csp = [
            `default-src 'none'`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `script-src 'nonce-${nonce}'`
        ].join('; ');

        return /* html */ `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; flex-direction: column;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
  }
  #messages { flex: 1; overflow-y: auto; padding: 8px; }
  .msg { margin: 0 0 10px; padding: 8px 10px; border-radius: 6px; white-space: pre-wrap; word-break: break-word; }
  .user { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
  .assistant { background: var(--vscode-editorWidget-background); }
  .role { font-size: 11px; opacity: .6; margin-bottom: 3px; }
  .error { color: var(--vscode-errorForeground); white-space: pre-wrap; padding: 8px 10px; }
  .empty { opacity: .6; padding: 12px; text-align: center; }
  #composer { display: flex; gap: 6px; padding: 8px; border-top: 1px solid var(--vscode-editorWidget-border); }
  #input {
    flex: 1; resize: none; min-height: 34px; max-height: 140px;
    font-family: inherit; font-size: inherit; padding: 6px 8px; border-radius: 4px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-editorWidget-border));
  }
  #send {
    padding: 0 12px; border: none; border-radius: 4px; cursor: pointer;
    color: var(--vscode-button-foreground); background: var(--vscode-button-background);
  }
  #send:hover { background: var(--vscode-button-hoverBackground); }
  #send:disabled { opacity: .5; cursor: default; }
</style>
</head>
<body>
  <div id="messages"><div class="empty">Pergunta algo ao Cinzel.</div></div>
  <div id="composer">
    <textarea id="input" rows="1" placeholder="Escreve uma mensagem… (Enter envia, Shift+Enter nova linha)"></textarea>
    <button id="send">Enviar</button>
  </div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const messages = document.getElementById('messages');
  const input = document.getElementById('input');
  const send = document.getElementById('send');
  let current = null; // bolha do assistente em construção

  function clearEmpty() {
    const e = messages.querySelector('.empty');
    if (e) e.remove();
  }
  function addBubble(role, text) {
    clearEmpty();
    const el = document.createElement('div');
    el.className = 'msg ' + role;
    const tag = document.createElement('div');
    tag.className = 'role';
    tag.textContent = role === 'user' ? 'Tu' : 'Cinzel';
    const body = document.createElement('span');
    body.textContent = text || '';
    el.appendChild(tag); el.appendChild(body);
    messages.appendChild(el);
    messages.scrollTop = messages.scrollHeight;
    return body;
  }
  function submit() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    autosize();
    vscode.postMessage({ type: 'send', text });
  }
  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  }

  send.addEventListener('click', submit);
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });

  window.addEventListener('message', ev => {
    const m = ev.data;
    if (m.type === 'user') { addBubble('user', m.text); }
    else if (m.type === 'assistant-start') { current = addBubble('assistant', ''); send.disabled = true; }
    else if (m.type === 'assistant-delta') { if (current) { current.textContent += m.text; messages.scrollTop = messages.scrollHeight; } }
    else if (m.type === 'assistant-end') { current = null; send.disabled = false; }
    else if (m.type === 'error') {
      const el = document.createElement('div'); el.className = 'error'; el.textContent = '⚠ ' + m.text;
      messages.appendChild(el); messages.scrollTop = messages.scrollHeight;
      current = null; send.disabled = false;
    }
    else if (m.type === 'clear') { messages.innerHTML = '<div class="empty">Conversa limpa.</div>'; current = null; send.disabled = false; }
  });
</script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
}
