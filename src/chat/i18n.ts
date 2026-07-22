import * as vscode from 'vscode';

/**
 * Diretiva de língua para a RESPOSTA da IA.
 *
 * A resposta do modelo segue a língua do utilizador. Por omissão ("auto")
 * segue a língua do editor (`vscode.env.language`); pode ser fixada em
 * `cinzel.responseLanguage` (útil para quem usa o editor em inglês mas quer
 * respostas em português, ou vice-versa).
 *
 * A diretiva é escrita NA PRÓPRIA LÍNGUA-ALVO — é o sinal mais forte para o
 * modelo responder nessa língua, mesmo que o resto do system prompt esteja
 * noutra língua.
 */
const DIRECTIVES: Record<string, string> = {
    'pt': 'Responde SEMPRE em português de Portugal.',
    'pt-br': 'Responda SEMPRE em português do Brasil.',
    'en': 'Always respond in English.',
    'es': 'Responde SIEMPRE en español.',
    'fr': 'Réponds TOUJOURS en français.',
    'de': 'Antworte IMMER auf Deutsch.',
    'it': 'Rispondi SEMPRE in italiano.',
    'nl': 'Antwoord ALTIJD in het Nederlands.',
    'zh-cn': '始终用简体中文回答。',
    'zh-tw': '一律以繁體中文回覆。',
    'ja': '常に日本語で回答してください。',
    'ko': '항상 한국어로 답변하세요.',
    'ru': 'Всегда отвечай на русском языке.'
};

/** Língua-alvo: a definição fixa, ou (em "auto") a língua do editor. */
function targetLocale(): string {
    const setting = vscode.workspace.getConfiguration('cinzel').get<string>('responseLanguage', 'auto');
    const locale = (setting && setting !== 'auto' ? setting : vscode.env.language) || 'en';
    return locale.toLowerCase();
}

/** Frase a injetar no system prompt para fixar a língua da resposta. */
export function responseLanguageDirective(): string {
    const locale = targetLocale();
    return DIRECTIVES[locale]
        ?? DIRECTIVES[locale.split('-')[0]]
        ?? `Always respond in the user's language (locale: ${locale}).`;
}
