import { ChatMessage, ProviderConfig } from './types';

/**
 * Fala com um endpoint compatível com OpenAI (`/chat/completions`) em streaming
 * e invoca `onDelta` a cada fragmento de texto.
 *
 * É escrito com `fetch` puro e parsing manual de SSE — de propósito: sem SDKs,
 * vês o protocolo real do provider, e o núcleo fica sem dependências. Funciona
 * com OpenAI, Groq, OpenRouter, DeepSeek, e servidores locais (Ollama/LM Studio).
 *
 * Nota: modelos de raciocínio (ex.: gpt-oss) emitem um campo `reasoning` à parte
 * do `content`. Aqui só lemos `content`, por isso a resposta mostrada é o texto
 * final, sem o "pensamento" — que é o que queres num chat.
 */
export async function streamChat(
    messages: ChatMessage[],
    cfg: ProviderConfig,
    onDelta: (text: string) => void
): Promise<void> {
    const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${cfg.apiKey}`
        },
        body: JSON.stringify({ model: cfg.model, messages, stream: true }),
        signal: cfg.signal
    });

    if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '');
        throw new Error(
            `HTTP ${res.status} ${res.statusText}` +
            (detail ? ` — ${detail.slice(0, 400)}` : '')
        );
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // SSE: linhas "data: {json}", eventos terminados por linha vazia; um chunk
    // da rede pode cortar uma linha a meio, por isso só processamos linhas
    // completas e mantemos o resto no buffer.
    for (; ;) {
        const { done, value } = await reader.read();
        if (done) { break; }
        buffer += decoder.decode(value, { stream: true });

        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line.startsWith('data:')) { continue; }
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') { return; }
            try {
                const json = JSON.parse(payload);
                const delta: string | undefined = json?.choices?.[0]?.delta?.content;
                if (delta) { onDelta(delta); }
            } catch {
                // linha ainda incompleta em raros casos — ignora com segurança
            }
        }
    }
}
