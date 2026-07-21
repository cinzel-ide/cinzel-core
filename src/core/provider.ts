import { ChatMessage, StreamConfig } from './types';
import { streamOpenAI } from './openai';
import { streamAnthropic } from './anthropic';

/**
 * Dispatcher: encaminha para o provider certo consoante `cfg.provider`.
 * É o único ponto que os chamadores (o adaptador do editor) precisam de conhecer.
 */
export async function streamChat(
    messages: ChatMessage[],
    cfg: StreamConfig,
    onDelta: (text: string) => void
): Promise<void> {
    if (cfg.provider === 'anthropic') {
        return streamAnthropic(messages, cfg, onDelta);
    }
    return streamOpenAI(messages, cfg, onDelta);
}
