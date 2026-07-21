// Bundle da extensão para um único out/extension.js.
// esbuild é rápido e não faz type-check (isso é o `npm run typecheck`).
const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

async function main() {
    const ctx = await esbuild.context({
        entryPoints: ['src/extension.ts'],
        bundle: true,
        format: 'cjs',
        platform: 'node',
        target: 'node18',
        outfile: 'out/extension.js',
        // 'vscode' é fornecido pelo host, nunca se empacota
        external: ['vscode'],
        sourcemap: !production,
        minify: production,
        logLevel: 'info'
    });
    if (watch) {
        await ctx.watch();
        console.log('[cinzel] a vigiar alterações…');
    } else {
        await ctx.rebuild();
        await ctx.dispose();
        console.log('[cinzel] build concluído');
    }
}

main().catch(e => { console.error(e); process.exit(1); });
