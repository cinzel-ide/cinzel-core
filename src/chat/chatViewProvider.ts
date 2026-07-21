import * as vscode from 'vscode';
import { streamChat } from '../core/provider';
import { ChatMessage } from '../core/types';

const API_KEY_SECRET = 'cinzel.apiKey';

/** Teto por anexo, para não estourar o orçamento de tokens (ex.: Groq 8K/min). */
const MAX_ATTACHMENT_CHARS = 12_000;

interface Attachment {
    id: string;
    /** Rótulo curto para o chip, ex.: "provider.ts:12–40". */
    label: string;
    /** Caminho relativo ao workspace (ou nome do ficheiro). */
    path: string;
    languageId: string;
    content: string;
    truncated: boolean;
}

/**
 * A vista de chat na barra lateral. Faz a ponte entre o webview (a UI) e o
 * Cinzel Core (`streamChat`). A chave vem do SecretStorage — keychain do SO.
 *
 * Contexto do editor: o utilizador anexa a seleção ou o ficheiro aberto; os
 * anexos ficam fixos como chips e são incluídos em cada pedido até serem
 * removidos. O conteúdo NÃO entra no histórico (para não reenviar a cada turno);
 * é acrescentado só à mensagem do turno atual.
 */
export class CinzelChatViewProvider implements vscode.WebviewViewProvider {

    public static readonly viewType = 'cinzel.chat';

    private view?: vscode.WebviewView;
    private history: ChatMessage[] = [];
    private attachments: Attachment[] = [];
    /** Último editor de texto real — o `activeTextEditor` fica indefinido quando o foco vai para o chat. */
    private lastEditor?: vscode.TextEditor;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.lastEditor = vscode.window.activeTextEditor;
        this.context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor(e => { if (e) { this.lastEditor = e; } })
        );
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.context.extensionUri]
        };
        view.webview.html = this.html(view.webview);
        view.webview.onDidReceiveMessage(async msg => {
            switch (msg?.type) {
                case 'send':
                    if (typeof msg.text === 'string' && msg.text.trim()) {
                        await this.handleSend(msg.text.trim());
                    }
                    break;
                case 'attach':
                    this.attachActiveEditor('auto');
                    break;
                case 'removeAttachment':
                    this.attachments = this.attachments.filter(a => a.id !== msg.id);
                    this.postAttachments();
                    break;
            }
        });
        this.postAttachments();
    }

    clear(): void {
        this.history = [];
        this.attachments = [];
        this.view?.webview.postMessage({ type: 'clear' });
        this.postAttachments();
    }

    /** Anexa a seleção, o ficheiro, ou (auto) a seleção se existir senão o ficheiro. */
    attachActiveEditor(mode: 'selection' | 'file' | 'auto'): void {
        const editor = this.lastEditor ?? vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('Cinzel: abre um ficheiro para o anexar ao chat.');
            return;
        }
        const doc = editor.document;
        const hasSelection = !editor.selection.isEmpty;
        const useSelection = mode === 'selection' || (mode === 'auto' && hasSelection);

        if (mode === 'selection' && !hasSelection) {
            vscode.window.showInformationMessage('Cinzel: sem seleção. Seleciona código primeiro (ou usa "Anexar ficheiro").');
            return;
        }

        const name = doc.uri.path.split('/').pop() ?? doc.fileName;
        let content: string;
        let label: string;
        if (useSelection) {
            const sel = editor.selection;
            content = doc.getText(sel);
            label = `${name}:${sel.start.line + 1}–${sel.end.line + 1}`;
        } else {
            content = doc.getText();
            label = name;
        }

        const truncated = content.length > MAX_ATTACHMENT_CHARS;
        if (truncated) {
            content = content.slice(0, MAX_ATTACHMENT_CHARS);
        }

        this.attachments.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            label: truncated ? `${label} (cortado)` : label,
            path: vscode.workspace.asRelativePath(doc.uri),
            languageId: doc.languageId,
            content,
            truncated
        });
        this.postAttachments();
    }

    private postAttachments(): void {
        this.view?.webview.postMessage({
            type: 'attachments',
            items: this.attachments.map(a => ({ id: a.id, label: a.label }))
        });
    }

    private buildContextBlock(): string {
        return this.attachments.map(a => {
            const head = `Ficheiro: ${a.path}${a.truncated ? ' (excerto)' : ''}`;
            return `${head}\n\`\`\`${a.languageId}\n${a.content}\n\`\`\``;
        }).join('\n\n');
    }

    private async handleSend(text: string): Promise<void> {
        const view = this.view;
        if (!view) { return; }

        const apiKey = await this.context.secrets.get(API_KEY_SECRET);
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

        // Histórico guarda o texto simples; o contexto só entra no turno atual.
        this.history.push({ role: 'user', content: text });
        view.webview.postMessage({ type: 'user', text });
        view.webview.postMessage({ type: 'assistant-start' });

        const contextBlock = this.attachments.length ? this.buildContextBlock() : '';
        const currentUser: ChatMessage = {
            role: 'user',
            content: contextBlock ? `${contextBlock}\n\n---\n\n${text}` : text
        };
        const requestMessages: ChatMessage[] = [
            {
                role: 'system',
                content: 'És o assistente do Cinzel IDE. Responde em português de Portugal, conciso e técnico. Formata código em blocos markdown. Quando te derem contexto de ficheiros, baseia a resposta nele.'
            },
            ...this.history.slice(0, -1),
            currentUser
        ];

        let answer = '';
        try {
            await streamChat(requestMessages, { baseUrl, apiKey, model }, delta => {
                answer += delta;
                view.webview.postMessage({ type: 'assistant-delta', text: delta });
            });
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
  #attachments { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 8px; }
  #attachments:empty { display: none; }
  .chip {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 1px 4px 1px 8px; border-radius: 10px; font-size: 11px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  .chip button { border: none; background: transparent; color: inherit; cursor: pointer; font-size: 13px; line-height: 1; padding: 0 2px; }
  #composer { display: flex; gap: 6px; padding: 8px; border-top: 1px solid var(--vscode-editorWidget-border); }
  #input {
    flex: 1; resize: none; min-height: 34px; max-height: 140px;
    font-family: inherit; font-size: inherit; padding: 6px 8px; border-radius: 4px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-editorWidget-border));
  }
  .btn { padding: 0 10px; border: none; border-radius: 4px; cursor: pointer;
    color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  .btn:hover { background: var(--vscode-button-hoverBackground); }
  .btn.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn:disabled { opacity: .5; cursor: default; }
</style>
</head>
<body>
  <div id="messages"><div class="empty">Pergunta algo ao Cinzel. Anexa a seleção ou o ficheiro para dar contexto.</div></div>
  <div id="attachments"></div>
  <div id="composer">
    <button id="attach" class="btn secondary" title="Anexar seleção / ficheiro aberto">📎</button>
    <textarea id="input" rows="1" placeholder="Escreve uma mensagem… (Enter envia, Shift+Enter nova linha)"></textarea>
    <button id="send" class="btn">Enviar</button>
  </div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const messages = document.getElementById('messages');
  const attachments = document.getElementById('attachments');
  const input = document.getElementById('input');
  const send = document.getElementById('send');
  const attach = document.getElementById('attach');
  let current = null;

  function clearEmpty() { const e = messages.querySelector('.empty'); if (e) e.remove(); }
  function addBubble(role, text) {
    clearEmpty();
    const el = document.createElement('div'); el.className = 'msg ' + role;
    const tag = document.createElement('div'); tag.className = 'role';
    tag.textContent = role === 'user' ? 'Tu' : 'Cinzel';
    const body = document.createElement('span'); body.textContent = text || '';
    el.appendChild(tag); el.appendChild(body);
    messages.appendChild(el); messages.scrollTop = messages.scrollHeight;
    return body;
  }
  function renderChips(items) {
    attachments.innerHTML = '';
    for (const it of items) {
      const chip = document.createElement('span'); chip.className = 'chip';
      const label = document.createElement('span'); label.textContent = it.label;
      const x = document.createElement('button'); x.textContent = '×'; x.title = 'Remover';
      x.addEventListener('click', () => vscode.postMessage({ type: 'removeAttachment', id: it.id }));
      chip.appendChild(label); chip.appendChild(x); attachments.appendChild(chip);
    }
  }
  function submit() {
    const text = input.value.trim(); if (!text) return;
    input.value = ''; autosize();
    vscode.postMessage({ type: 'send', text });
  }
  function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; }

  send.addEventListener('click', submit);
  attach.addEventListener('click', () => vscode.postMessage({ type: 'attach' }));
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });

  window.addEventListener('message', ev => {
    const m = ev.data;
    if (m.type === 'user') { addBubble('user', m.text); }
    else if (m.type === 'assistant-start') { current = addBubble('assistant', ''); send.disabled = true; }
    else if (m.type === 'assistant-delta') { if (current) { current.textContent += m.text; messages.scrollTop = messages.scrollHeight; } }
    else if (m.type === 'assistant-end') { current = null; send.disabled = false; }
    else if (m.type === 'attachments') { renderChips(m.items || []); }
    else if (m.type === 'error') {
      const el = document.createElement('div'); el.className = 'error'; el.textContent = '⚠ ' + m.text;
      messages.appendChild(el); messages.scrollTop = messages.scrollHeight; current = null; send.disabled = false;
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
