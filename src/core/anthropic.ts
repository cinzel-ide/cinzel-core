import { ChatMessage, StreamConfig } from './types';
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
