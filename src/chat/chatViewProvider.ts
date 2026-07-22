import * as vscode from 'vscode';
import { streamChat } from '../core/provider';
import { runAgent } from '../core/agent';
import { TOOL_SPECS, executeTool } from './tools';
import { responseLanguageDirective } from './i18n';
import { AgentMessage, ChatMessage, ModelSpec, StreamConfig } from '../core/types';

const MAX_ATTACHMENT_CHARS = 12_000;

const DEFAULT_MODELS: ModelSpec[] = [
    { id: 'groq-gpt-oss-120b', label: 'Groq · gpt-oss-120b (grátis)', provider: 'openai', baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b' },
    { id: 'groq-llama-3.3-70b', label: 'Groq · llama-3.3-70b (grátis)', provider: 'openai', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
    { id: 'anthropic-claude-sonnet', label: 'Anthropic · Claude Sonnet 4', provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-20250514', maxTokens: 4096 },
    { id: 'openai-gpt-4o', label: 'OpenAI · GPT-4o', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' }
];

/** System prompt do agente. A língua da resposta é dinâmica (ver i18n). */
function agentSystem(): string {
    return (
        'És o Cinzel a fazer pair programming — um programador sénior ao lado do utilizador. ' +
        responseLanguageDirective() + ' Sê conciso e técnico, como um colega de equipa.\n\n' +
        'Pensas no PROJETO INTEIRO, não só no ficheiro atual. Fluxo:\n' +
        '1. INVESTIGA primeiro: usa search_text para ver o que JÁ EXISTE (evita duplicar), ' +
        'find_files para mapear a estrutura, read_file/list_dir para perceber o contexto. ' +
        'Aponta o que encontras: "já existe um X", "isto é usado em 3 sítios", riscos.\n' +
        '2. PLANEIA: se a tarefa modifica ficheiros, chama SEMPRE propose_plan (passos, ficheiros ' +
        'a criar/editar, risco) e ESPERA aprovação. Pensa também no que também deve ser atualizado ' +
        '(testes, documentação, chamadas relacionadas).\n' +
        '3. IMPLEMENTA só depois de o plano ser aprovado, com write_file (cada escrita é confirmada).\n\n' +
        'REGRA CRÍTICA: quando a tarefa é adicionar/criar/alterar código num ficheiro, mostrar o ' +
        'código em texto NÃO serve — o ficheiro só muda se usares write_file. Não termines sem ' +
        'write_file quando a tarefa é modificar um ficheiro.\n' +
        'Se for só uma pergunta, responde diretamente — não faças plano para nada. ' +
        'Nunca inventes conteúdos de ficheiros: lê-os.'
    );
}

interface Attachment {
    id: string; label: string; path: string; languageId: string; content: string; truncated: boolean;
}

/**
 * Vista de chat: chat simples (streaming) OU agente (loop de ferramentas).
 * Multi-provider, chaves por baseUrl no SecretStorage.
 */
export class CinzelChatViewProvider implements vscode.WebviewViewProvider {

    public static readonly viewType = 'cinzel.chat';

    private view?: vscode.WebviewView;
    private history: ChatMessage[] = [];
    private attachments: Attachment[] = [];
    private lastEditor?: vscode.TextEditor;
    private agentMode: boolean;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.lastEditor = vscode.window.activeTextEditor;
        this.agentMode = context.globalState.get<boolean>('cinzel.agentMode', false);
        this.context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor(e => { if (e) { this.lastEditor = e; } })
        );
    }

    // --- modelos & chaves ---

    private models(): ModelSpec[] {
        const cfg = vscode.workspace.getConfiguration('cinzel').get<ModelSpec[]>('models', []);
        return cfg && cfg.length ? cfg : DEFAULT_MODELS;
    }
    private activeModel(): ModelSpec {
        const id = this.context.globalState.get<string>('cinzel.activeModel');
        const models = this.models();
        return models.find(m => m.id === id) ?? models[0];
    }
    private async setActiveModel(id: string): Promise<void> {
        await this.context.globalState.update('cinzel.activeModel', id);
        this.postModels();
    }
    private secretKeyId(baseUrl: string): string { return `cinzel.key:${baseUrl}`; }

    async promptSetApiKey(): Promise<void> {
        const spec = this.activeModel();
        const key = await vscode.window.showInputBox({
            title: vscode.l10n.t('API key for {0}', spec.label),
            prompt: vscode.l10n.t('Endpoint {0} — stored in the system keychain, never in plain text.', spec.baseUrl),
            password: true, ignoreFocusOut: true
        });
        if (key && key.trim()) {
            await this.context.secrets.store(this.secretKeyId(spec.baseUrl), key.trim());
            vscode.window.showInformationMessage(vscode.l10n.t('Cinzel: key stored for {0} ({1}).', spec.provider, spec.baseUrl));
        }
    }
    async promptClearApiKey(): Promise<void> {
        const spec = this.activeModel();
        await this.context.secrets.delete(this.secretKeyId(spec.baseUrl));
        vscode.window.showInformationMessage(vscode.l10n.t('Cinzel: key removed for {0} ({1}).', spec.provider, spec.baseUrl));
    }
    async promptSelectModel(): Promise<void> {
        const models = this.models();
        const pick = await vscode.window.showQuickPick(
            models.map(m => ({ label: m.label, description: m.model, id: m.id })),
            { title: vscode.l10n.t('Cinzel model') }
        );
        if (pick) { await this.setActiveModel((pick as { id: string }).id); }
    }

    // --- webview ---

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri] };
        view.webview.html = this.html(view.webview);
        view.webview.onDidReceiveMessage(async msg => {
            switch (msg?.type) {
                case 'send':
                    if (typeof msg.text === 'string' && msg.text.trim()) { await this.handleSend(msg.text.trim()); }
                    break;
                case 'attach': this.attachActiveEditor('auto'); break;
                case 'removeAttachment':
                    this.attachments = this.attachments.filter(a => a.id !== msg.id);
                    this.postAttachments(); break;
                case 'setModel':
                    if (typeof msg.id === 'string') { await this.setActiveModel(msg.id); } break;
                case 'setAgentMode':
                    this.agentMode = !!msg.value;
                    await this.context.globalState.update('cinzel.agentMode', this.agentMode); break;
            }
        });
        this.postModels();
        this.postAttachments();
        this.postState();
    }

    clear(): void {
        this.history = [];
        this.attachments = [];
        this.view?.webview.postMessage({ type: 'clear' });
        this.postAttachments();
    }

    private postModels(): void {
        this.view?.webview.postMessage({
            type: 'models',
            items: this.models().map(m => ({ id: m.id, label: m.label })),
            active: this.activeModel().id
        });
    }
    private postState(): void {
        this.view?.webview.postMessage({ type: 'state', agentMode: this.agentMode });
    }

    // --- anexos ---

    attachActiveEditor(mode: 'selection' | 'file' | 'auto'): void {
        const editor = this.lastEditor ?? vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showInformationMessage(vscode.l10n.t('Cinzel: open a file to attach it to the chat.')); return; }
        const doc = editor.document;
        const hasSelection = !editor.selection.isEmpty;
        if (mode === 'selection' && !hasSelection) {
            vscode.window.showInformationMessage(vscode.l10n.t('Cinzel: no selection. Select code first (or use "Attach file").')); return;
        }
        const useSelection = mode === 'selection' || (mode === 'auto' && hasSelection);
        const name = doc.uri.path.split('/').pop() ?? doc.fileName;
        let content: string; let label: string;
        if (useSelection) {
            const sel = editor.selection;
            content = doc.getText(sel);
            label = `${name}:${sel.start.line + 1}–${sel.end.line + 1}`;
        } else { content = doc.getText(); label = name; }
        const truncated = content.length > MAX_ATTACHMENT_CHARS;
        if (truncated) { content = content.slice(0, MAX_ATTACHMENT_CHARS); }
        this.attachments.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            label: truncated ? vscode.l10n.t('{0} (truncated)', label) : label,
            path: vscode.workspace.asRelativePath(doc.uri),
            languageId: doc.languageId, content, truncated
        });
        this.postAttachments();
    }
    private postAttachments(): void {
        this.view?.webview.postMessage({ type: 'attachments', items: this.attachments.map(a => ({ id: a.id, label: a.label })) });
    }
    private buildContextBlock(): string {
        return this.attachments.map(a => `Ficheiro: ${a.path}${a.truncated ? ' (excerto)' : ''}\n\`\`\`${a.languageId}\n${a.content}\n\`\`\``).join('\n\n');
    }

    // --- envio ---

    private async resolveKey(spec: ModelSpec): Promise<string | undefined> {
        return this.context.secrets.get(this.secretKeyId(spec.baseUrl));
    }
    private streamConfig(spec: ModelSpec, apiKey: string): StreamConfig {
        return { provider: spec.provider, baseUrl: spec.baseUrl, apiKey, model: spec.model, maxTokens: spec.maxTokens };
    }

    private async handleSend(text: string): Promise<void> {
        const view = this.view;
        if (!view) { return; }
        const spec = this.activeModel();
        const apiKey = await this.resolveKey(spec);
        if (!apiKey) {
            view.webview.postMessage({ type: 'error', text: vscode.l10n.t('No key for {0}. Run "Cinzel: Set API key…" (⇧⌘P) with this model active.', spec.label) });
            return;
        }
        if (this.agentMode) { await this.runAgentTurn(text, view, spec, apiKey); }
        else { await this.runChatTurn(text, view, spec, apiKey); }
    }

    private async runChatTurn(text: string, view: vscode.WebviewView, spec: ModelSpec, apiKey: string): Promise<void> {
        this.history.push({ role: 'user', content: text });
        view.webview.postMessage({ type: 'user', text });
        view.webview.postMessage({ type: 'assistant-start' });
        const contextBlock = this.attachments.length ? this.buildContextBlock() : '';
        const requestMessages: ChatMessage[] = [
            { role: 'system', content: 'És o assistente do Cinzel IDE. ' + responseLanguageDirective() + ' Sê conciso e técnico. Formata código em blocos markdown. Quando te derem contexto de ficheiros, baseia a resposta nele.' },
            ...this.history.slice(0, -1),
            { role: 'user', content: contextBlock ? `${contextBlock}\n\n---\n\n${text}` : text }
        ];
        let answer = '';
        try {
            await streamChat(requestMessages, this.streamConfig(spec, apiKey), delta => {
                answer += delta;
                view.webview.postMessage({ type: 'assistant-delta', text: delta });
            });
            this.history.push({ role: 'assistant', content: answer });
            view.webview.postMessage({ type: 'assistant-end' });
        } catch (e) {
            view.webview.postMessage({ type: 'error', text: e instanceof Error ? e.message : String(e) });
        }
    }

    private async runAgentTurn(text: string, view: vscode.WebviewView, spec: ModelSpec, apiKey: string): Promise<void> {
        this.history.push({ role: 'user', content: text });
        view.webview.postMessage({ type: 'user', text });
        view.webview.postMessage({ type: 'agent-start' });
        const contextBlock = this.attachments.length ? this.buildContextBlock() : '';
        const priorTurns: AgentMessage[] = this.history.slice(0, -1).map(m => ({ role: m.role, content: m.content }) as AgentMessage);
        const messages: AgentMessage[] = [
            { role: 'system', content: agentSystem() },
            ...priorTurns,
            { role: 'user', content: contextBlock ? `${contextBlock}\n\n---\n\n${text}` : text }
        ];
        try {
            const final = await runAgent(messages, TOOL_SPECS, this.streamConfig(spec, apiKey), {
                onText: t => view.webview.postMessage({ type: 'assistant-text', text: t }),
                onToolCall: c => view.webview.postMessage({ type: 'tool-call', name: c.name, args: summarizeArgs(c.arguments) }),
                onToolResult: (c, r) => view.webview.postMessage({ type: 'tool-result', name: c.name, summary: r.slice(0, 140) }),
                executeTool
            });
            this.history.push({ role: 'assistant', content: final });
        } catch (e) {
            view.webview.postMessage({ type: 'error', text: e instanceof Error ? e.message : String(e) });
        }
        view.webview.postMessage({ type: 'agent-end' });
    }

    private html(webview: vscode.Webview): string {
        const nonce = getNonce();
        const csp = [`default-src 'none'`, `style-src ${webview.cspSource} 'unsafe-inline'`, `script-src 'nonce-${nonce}'`].join('; ');
        // Strings da UI do webview: resolvidas no extension host (onde vscode.l10n
        // existe) e injetadas no HTML/script (onde não existe).
        const L = {
            model: vscode.l10n.t('Model'),
            agent: vscode.l10n.t('Agent'),
            agentTitle: vscode.l10n.t('The agent can read, list and write files (with confirmation).'),
            empty: vscode.l10n.t('Ask Cinzel something. Attach context, or turn on the Agent to let it act on files.'),
            attachTitle: vscode.l10n.t('Attach selection / open file'),
            placeholder: vscode.l10n.t('Write a message… (Enter sends, Shift+Enter new line)'),
            send: vscode.l10n.t('Send'),
            you: vscode.l10n.t('You'),
            remove: vscode.l10n.t('Remove'),
            cleared: vscode.l10n.t('Conversation cleared.')
        };
        const lang = (vscode.env.language || 'en').split('-')[0];
        return /* html */ `<!DOCTYPE html>
<html lang="${lang}"><head>
<meta charset="UTF-8" /><meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
  #topbar { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--vscode-editorWidget-border); }
  #topbar label { font-size: 11px; opacity: .7; white-space: nowrap; }
  #model { flex: 1; font-family: inherit; font-size: 12px; padding: 2px 4px; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border, var(--vscode-editorWidget-border)); border-radius: 4px; }
  #messages { flex: 1; overflow-y: auto; padding: 8px; }
  .msg { margin: 0 0 10px; padding: 8px 10px; border-radius: 6px; white-space: pre-wrap; word-break: break-word; }
  .user { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
  .assistant { background: var(--vscode-editorWidget-background); }
  .role { font-size: 11px; opacity: .6; margin-bottom: 3px; }
  .tool { font-size: 12px; opacity: .8; padding: 2px 10px; font-family: var(--vscode-editor-font-family, monospace); }
  .error { color: var(--vscode-errorForeground); white-space: pre-wrap; padding: 8px 10px; }
  .empty { opacity: .6; padding: 12px; text-align: center; }
  #attachments { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 8px; }
  #attachments:empty { display: none; }
  .chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 4px 1px 8px; border-radius: 10px; font-size: 11px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .chip button { border: none; background: transparent; color: inherit; cursor: pointer; font-size: 13px; line-height: 1; padding: 0 2px; }
  #composer { display: flex; gap: 6px; padding: 8px; border-top: 1px solid var(--vscode-editorWidget-border); }
  #input { flex: 1; resize: none; min-height: 34px; max-height: 140px; font-family: inherit; font-size: inherit; padding: 6px 8px; border-radius: 4px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-editorWidget-border)); }
  .btn { padding: 0 10px; border: none; border-radius: 4px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  .btn:hover { background: var(--vscode-button-hoverBackground); }
  .btn.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn:disabled { opacity: .5; cursor: default; }
  #agentwrap { display: flex; align-items: center; gap: 3px; }
</style></head>
<body>
  <div id="topbar">
    <label>${L.model}</label><select id="model"></select>
    <span id="agentwrap"><input type="checkbox" id="agent" /><label for="agent" title="${L.agentTitle}">${L.agent}</label></span>
  </div>
  <div id="messages"><div class="empty">${L.empty}</div></div>
  <div id="attachments"></div>
  <div id="composer">
    <button id="attach" class="btn secondary" title="${L.attachTitle}">📎</button>
    <textarea id="input" rows="1" placeholder="${L.placeholder}"></textarea>
    <button id="send" class="btn">${L.send}</button>
  </div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const L = ${JSON.stringify(L)};
  const messages = document.getElementById('messages');
  const attachments = document.getElementById('attachments');
  const model = document.getElementById('model');
  const agent = document.getElementById('agent');
  const input = document.getElementById('input');
  const send = document.getElementById('send');
  const attach = document.getElementById('attach');
  let current = null;

  function clearEmpty() { const e = messages.querySelector('.empty'); if (e) e.remove(); }
  function addBubble(role, text) {
    clearEmpty();
    const el = document.createElement('div'); el.className = 'msg ' + role;
    const tag = document.createElement('div'); tag.className = 'role'; tag.textContent = role === 'user' ? L.you : 'Cinzel';
    const body = document.createElement('span'); body.textContent = text || '';
    el.appendChild(tag); el.appendChild(body); messages.appendChild(el); messages.scrollTop = messages.scrollHeight;
    return body;
  }
  function addLine(cls, text) { clearEmpty(); const el = document.createElement('div'); el.className = cls; el.textContent = text; messages.appendChild(el); messages.scrollTop = messages.scrollHeight; }
  function renderChips(items) {
    attachments.innerHTML = '';
    for (const it of items) {
      const chip = document.createElement('span'); chip.className = 'chip';
      const label = document.createElement('span'); label.textContent = it.label;
      const x = document.createElement('button'); x.textContent = '×'; x.title = L.remove;
      x.addEventListener('click', () => vscode.postMessage({ type: 'removeAttachment', id: it.id }));
      chip.appendChild(label); chip.appendChild(x); attachments.appendChild(chip);
    }
  }
  function renderModels(items, active) {
    model.innerHTML = '';
    for (const it of items) { const o = document.createElement('option'); o.value = it.id; o.textContent = it.label; if (it.id === active) o.selected = true; model.appendChild(o); }
  }
  function submit() { const text = input.value.trim(); if (!text) return; input.value = ''; autosize(); vscode.postMessage({ type: 'send', text }); }
  function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; }

  send.addEventListener('click', submit);
  attach.addEventListener('click', () => vscode.postMessage({ type: 'attach' }));
  model.addEventListener('change', () => vscode.postMessage({ type: 'setModel', id: model.value }));
  agent.addEventListener('change', () => vscode.postMessage({ type: 'setAgentMode', value: agent.checked }));
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });

  window.addEventListener('message', ev => {
    const m = ev.data;
    if (m.type === 'user') { addBubble('user', m.text); }
    else if (m.type === 'assistant-start') { current = addBubble('assistant', ''); send.disabled = true; }
    else if (m.type === 'assistant-delta') { if (current) { current.textContent += m.text; messages.scrollTop = messages.scrollHeight; } }
    else if (m.type === 'assistant-end') { current = null; send.disabled = false; }
    else if (m.type === 'assistant-text') { addBubble('assistant', m.text); }
    else if (m.type === 'agent-start') { send.disabled = true; }
    else if (m.type === 'agent-end') { send.disabled = false; }
    else if (m.type === 'tool-call') { addLine('tool', '🔧 ' + m.name + '(' + (m.args || '') + ')'); }
    else if (m.type === 'tool-result') { addLine('tool', '  ↳ ' + m.summary); }
    else if (m.type === 'attachments') { renderChips(m.items || []); }
    else if (m.type === 'models') { renderModels(m.items || [], m.active); }
    else if (m.type === 'state') { agent.checked = !!m.agentMode; }
    else if (m.type === 'error') { addLine('error', '⚠ ' + m.text); current = null; send.disabled = false; }
    else if (m.type === 'clear') { messages.innerHTML = '<div class="empty">' + L.cleared + '</div>'; current = null; send.disabled = false; }
  });
</script>
</body></html>`;
    }
}

function summarizeArgs(args: Record<string, unknown>): string {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(args)) {
        const s = typeof v === 'string' ? v : JSON.stringify(v);
        parts.push(`${k}: ${s.length > 40 ? s.slice(0, 40) + '…' : s}`);
    }
    return parts.join(', ');
}

function getNonce(): string {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) { text += chars.charAt(Math.floor(Math.random() * chars.length)); }
    return text;
}
