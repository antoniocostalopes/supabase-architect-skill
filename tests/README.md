# Tests — Supabase Architect

Validação da própria skill. Não é teste de Supabase; é teste de **se a skill faz o que diz**.

## Estrutura

```
tests/
├── README.md              (este ficheiro)
├── eval/
│   ├── README.md          # como correr a suite (automatizado + manual)
│   ├── prompts.md         # 12 cenários de input do user
│   ├── rubric.md          # critérios + scoring (10 pontos por cenário)
│   ├── expected.md        # sinais esperados por cenário
│   ├── runner.ts          # runner automatizado (Anthropic SDK)
│   ├── utils.ts           # helpers de parsing + scoring
│   ├── package.json       # dependências (npm install)
│   ├── tsconfig.json      # TypeScript config
│   ├── .env.example       # template para ANTHROPIC_API_KEY
│   └── .gitignore         # node_modules, .env
└── results/
    └── README.md          # resultados das corridas
```

## Como funciona

Não é unit testing tradicional. É **eval suite** com dois modos:

### Modo automatizado (recomendado)
```bash
cd tests/eval/
npm install
cp .env.example .env  # preencher ANTHROPIC_API_KEY
npm run eval          # suite completa (~$0.30-0.60)
# ou
npm run eval:smoke    # 4 cenários (~$0.10)
```

Output: relatório em `tests/results/<timestamp>.md` com score automático.

### Modo manual (auditoria rigorosa)
1. Pegar num cenário de [`eval/prompts.md`](eval/prompts.md)
2. Abrir Claude Code num projeto teste com a skill instalada
3. Colar o prompt
4. Avaliar output contra [`eval/expected.md`](eval/expected.md) usando [`eval/rubric.md`](eval/rubric.md)
5. Registar score

Detalhes completos em [`eval/README.md`](eval/README.md).

## Por que existe

- **Detetar regressões**: se mudar `references/01-rls-patterns.md`, output do cenário "audita policy" continua correto?
- **Validar coerência**: a skill ativa nos pedidos esperados?
- **Calibrar severidade**: a skill **não infla** Crítico/Alto?
- **Cobertura**: cobre os 13 lentes na audit completo?

## Estado

| Cenários | 12 |
|---|---|
| Cobertura por capacidade | 13/13 |
| Cobertura por comando | 12/12 |
| Cobertura por domínio | 5/5 |

## Quando adicionar cenários novos

- Sempre que adicionas reference nova → 1 cenário que exige carregar essa reference
- Sempre que adicionas command novo → 1 cenário que invoca o command
- Sempre que adicionas anti-pattern (V21+) → 1 cenário que deve detetá-lo
- Sempre que recebes feedback de "skill errou aqui" → 1 cenário de regressão

## Futuro

- **CI integration** que falha PR se score baixar abaixo de threshold (exit code 1 já implementado no runner)
- **LLM-as-judge** opcional (Claude avalia output em vez de regex match heurístico) — sobe precisão de D3 dramaticamente
- **Histórico de scores** ao longo do tempo (gráfico) para detetar regressões silenciosas
- **Benchmark contínuo** vs Claude vanilla a cada release
