import { fimComplete } from '../src/core/completion';
(async () => {
  // 3 cenários FIM reais
  const cases = [
    { p: 'function factorial(n) {\n  if (n <= 1) return 1;\n  return n * ', s: '\n}', want: /factorial\(n\s*-\s*1\)/ },
    { p: 'const nums = [1, 2, 3];\nconst dobro = nums.map(', s: ');\n', want: /=>|function|\*\s*2/ },
    { p: 'interface User {\n  id: number;\n  ', s: '\n}', want: /:/ }
  ];
  let ok = 0;
  for (const c of cases) {
    const out = await fimComplete(c.p, c.s, { host: 'http://localhost:11434', model: 'qwen2.5-coder:1.5b-base', maxTokens: 32 });
    const hit = c.want.test(out);
    if (hit) ok++;
    console.log((hit ? 'OK ' : '.. ') + JSON.stringify(out.slice(0, 50)));
  }
  console.log('\nFIM_WRAPPER_OK=' + (ok >= 2) + ' (' + ok + '/3 cenários razoáveis)');
  process.exit(ok >= 2 ? 0 : 2);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
