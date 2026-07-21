import { AgentMessage, AgentTurn, ChatMessage, StreamConfig, ToolCall, ToolSpec } from './types';
import { forEachSseData, httpError } from './openai';

/**
 * API nativa da Anthropic (Messages), em streaming. NÃO é compatível com OpenAI:
 *  - endpoint `/messages`; auth por `x-api-key` + `anthropic-version`
 *  - `system` é um campo de topo, não uma mensagem com role 'system'
 *  - `max_tokens` é obrigatório
 *  - o streaming vem em eventos `content_block_delta` com `delta.text`
 */
export async function streamAnthropic(
    messages: ChatMessage[],
    cfg: StreamConfig,
    onDelta: (text: string) => void
): Promise<void> {
    // extrai o(s) system das mensagens; a Anthropic só aceita user/assistant
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const turns = messages
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role, content: m.content }));

    const url = `${cfg.baseUrl.replace(/\/+$/, '')}/messages`;

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-api-key': cfg.apiKey,
            'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
            model: cfg.model,
            max_tokens: cfg.maxTokens ?? 4096,
            system: system || undefined,
            messages: turns,
            stream: true
        }),
        signal: cfg.signal
    });

    if (!res.ok || !res.body) {
        throw new Error(await httpError(res));
    }

    await forEachSseData(res.body, payload => {
        try {
            const ev = JSON.parse(payload);
            if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
                onDelta(ev.delta.text as string);
            } else if (ev?.type === 'message_stop') {
                return true;
            } else if (ev?.type === 'error') {
                throw new Error(ev.error?.message ?? 'erro da Anthropic');
            }
        } catch (e) {
            // JSON incompleto é ignorado; um erro real da API re-lança
            if (e instanceof Error && e.message.includes('Anthropic')) { throw e; }
        }
        return false;
    });
}

// --- tool-calling (não-streaming) ---

/**
 * Serializa mensagens do agente para o formato da Anthropic. Regras próprias:
 *  - o assistente com ferramentas manda blocos `text` + `tool_use`
 *  - os resultados de ferramentas vão em mensagens `user` com blocos
 *    `tool_result`; resultados consecutivos são AGRUPADOS num só `user`
 *    (a API exige alternância estrita user/assistant).
 */
function toAnthropicMessages(messages: AgentMessage[]): { system: string; turns: unknown[] } {
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const turns: unknown[] = [];
    let pendingToolResults: unknown[] = [];

    const flush = () => {
        if (pendingToolResults.length) {
            turns.push({ role: 'user', content: pendingToolResults });
            pendingToolResults = [];
        }
    };

    for (const m of messages) {
        if (m.role === 'system') { continue; }
        if (m.role === 'tool') {
            pendingToolResults.push({ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content });
            continue;
        }
        flush();
        if (m.role === 'user') {
            turns.push({ role: 'user', content: m.content });
        } else {
            const blocks: unknown[] = [];
            if (m.content) { blocks.push({ type: 'text', text: m.content }); }
            for (const c of m.toolCalls ?? []) {
                blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments });
            }
            turns.push({ role: 'assistant', content: blocks });
        }
    }
    flush();
    return { system, turns };
}

export async function completeAnthropic(
    messages: AgentMessage[],
    tools: ToolSpec[],
    cfg: StreamConfig
): Promise<AgentTurn> {
    const { system, turns } = toAnthropicMessages(messages);
    const url = `${cfg.baseUrl.replace(/\/+$/, '')}/messages`;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-api-key': cfg.apiKey,
            'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
            model: cfg.model,
            max_tokens: cfg.maxTokens ?? 4096,
            system: system || undefined,
            tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })),
            messages: turns
        }),
        signal: cfg.signal
    });
    if (!res.ok) { throw new Error(await httpError(res)); }
    const json = await res.json() as {
        content: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[];
    };
    let text = '';
    const toolCalls: ToolCall[] = [];
    for (const block of json.content ?? []) {
        if (block.type === 'text' && block.text) { text += block.text; }
        else if (block.type === 'tool_use' && block.id && block.name) {
            toolCalls.push({ id: block.id, name: block.name, arguments: block.input ?? {} });
        }
    }
    return { text, toolCalls };
}
