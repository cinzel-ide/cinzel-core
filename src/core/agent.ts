import { AgentMessage, AgentTurn, StreamConfig, ToolCall, ToolSpec } from './types';
import { completeOpenAI } from './openai';
import { completeAnthropic } from './anthropic';

/**
 * Teto de iterações do loop agêntico. É a rede de segurança contra loops
 * descontrolados (uma ferramenta que falha e repete, um plano que não
 * converge) — o modo de falha caro que já discutimos.
 */
export const MAX_AGENT_ITERATIONS = 10;

export interface AgentHooks {
    /** Texto do assistente num turno (pode haver vários). */
    onText?(text: string): void;
    /** O agente vai executar esta ferramenta. */
    onToolCall?(call: ToolCall): void;
    /** Resultado da ferramenta (para mostrar no chat). */
    onToolResult?(call: ToolCall, result: string): void;
    /** Executa a ferramenta e devolve o resultado (texto). Injetado pelo editor. */
    executeTool(call: ToolCall): Promise<string>;
}

/** Um turno via o provider certo, com ferramentas, sem streaming. */
async function complete(messages: AgentMessage[], tools: ToolSpec[], cfg: StreamConfig): Promise<AgentTurn> {
    if (cfg.provider === 'anthropic') {
        return completeAnthropic(messages, tools, cfg);
    }
    return completeOpenAI(messages, tools, cfg);
}

/**
 * Corre o loop: modelo → (pede ferramentas) → executa → devolve resultados →
 * repete, até o modelo responder sem pedir ferramentas (ou bater no teto).
 * A execução de ferramentas é injetada (`hooks.executeTool`), por isso o núcleo
 * não sabe nada do editor. Devolve o texto final.
 */
export async function runAgent(
    messages: AgentMessage[],
    tools: ToolSpec[],
    cfg: StreamConfig,
    hooks: AgentHooks
): Promise<string> {
    const convo: AgentMessage[] = [...messages];
    let finalText = '';

    for (let i = 0; i < MAX_AGENT_ITERATIONS; i++) {
        const turn = await complete(convo, tools, cfg);
        if (turn.text) {
            finalText = turn.text;
            hooks.onText?.(turn.text);
        }
        convo.push({
            role: 'assistant',
            content: turn.text,
            toolCalls: turn.toolCalls.length ? turn.toolCalls : undefined
        });

        if (turn.toolCalls.length === 0) {
            return finalText; // resposta final
        }

        for (const call of turn.toolCalls) {
            hooks.onToolCall?.(call);
            let result: string;
            try {
                result = await hooks.executeTool(call);
            } catch (e) {
                result = 'ERRO: ' + (e instanceof Error ? e.message : String(e));
            }
            hooks.onToolResult?.(call, result);
            convo.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result });
        }
    }

    const capped = '[Cinzel: limite de iterações do agente atingido — parei por segurança.]';
    hooks.onText?.(capped);
    return finalText || capped;
}
