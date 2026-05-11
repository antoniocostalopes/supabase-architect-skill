# Eval Suite — How to Run

Validação da skill contra os 12 cenários canónicos. Disponível em **dois modos**:

- **Automatizado** (recomendado para iterar): `runner.ts` invoca a Anthropic API e pontua automaticamente
- **Manual** (para auditoria rigorosa): leitura humana com `rubric.md` aplicado a outputs gerados manualmente

## Modo automatizado (recomendado)

### Setup (uma vez)
```bash
cd tests/eval/
npm install
cp .env.example .env
# Editar .env e colocar ANTHROPIC_API_KEY
```

### Correr suite completa
```bash
npm run eval
```

Saída: relatório em `tests/results/<timestamp>.md` com score total, breakdown por prompt, cenários abaixo de 7/10.

### Smoke test rápido (4 prompts em vez de 12)
```bash
npm run eval:smoke
```

Corre P01 (audit completo), P04 (performance), P06 (RAG), P11 (hotel/booking). ~30s + custo baixo (~$0.10).

### Baseline (vanilla Claude sem skill)
```bash
npm run eval:baseline
```

Saída em `tests/results/<timestamp>.baseline.md`. Compara para validar que a skill efetivamente acrescenta valor.

### Comparar com + sem skill
```bash
npm run eval:compare
```

Corre as duas modalidades. Diferença típica esperada: **+40-60 pontos** em 120 quando a skill está carregada.

### Flags adicionais
```bash
npx tsx runner.ts --only P01,P04,P11           # cenários específicos
npx tsx runner.ts --model claude-opus-4-7      # override do modelo
npx tsx runner.ts --no-write                   # imprime no stdout
npx tsx runner.ts --help                       # ver todas as flags
```

### Pré-requisitos
- Node.js ≥20
- `ANTHROPIC_API_KEY` (obter em https://console.anthropic.com/)

### Custo estimado

- **Suite completa** (12 prompts, modelo Sonnet 4.6): ~$0.30-0.60 por corrida
- **Smoke test** (4 prompts): ~$0.10
- **Baseline**: idêntico ao normal
- **Comparação** (suite + baseline): ~$0.60-1.20

Valores aproximados; ver `usage` no relatório para detalhe.

### Exit codes (útil em CI)
- `0` — score ≥ 80% (A− ou superior)
- `1` — score < 80% (regressão)

## Modo manual (auditoria rigorosa)

Quando precisas **certeza absoluta** ou estás a debugar um cenário específico.

### Procedimento

1. Abrir [`prompts.md`](prompts.md) e escolher um cenário.
2. Configurar o **contexto descrito** (criar ficheiros mínimos no projeto teste).
3. Colar o prompt do user no Claude Code (com a skill instalada).
4. Guardar o output em ficheiro temporário.
5. Aplicar [`rubric.md`](rubric.md) → score 0-10.
6. Comparar com [`expected.md`](expected.md) e marcar red flags.
7. Documentar em `tests/results/v<versão>-manual-<YYYYMMDD>.md`.

## Quando usar cada modo

| Caso | Modo |
|---|---|
| **Iterar rapidamente** durante desenvolvimento | Automatizado |
| **Pre-release** (antes de bump de versão) | Ambos: automatizado + manual nos cenários abaixo de 8/10 |
| **Investigar regressão** | Manual no cenário afetado + comparação contra resultado anterior |
| **Demonstração comercial** | Manual com cliente (cenário do domínio dele) |
| **CI / pre-merge** | Automatizado (smoke test) |
| **Calibrar nova versão da skill** | Comparar baseline ↔ skill carregada |

## Limitações do scoring automático

O runner usa **heurísticas** (keyword/regex match) para pontuar. Tem limitações:

- **D1 Activation**: deteta menção de command, não confirma uso correto
- **D2 Loading**: deteta menção de references, não confirma loading real
- **D3 Detection**: keywords/regex podem falhar em sinónimos ou paráfrases
- **D4 Quality**: heurística simples (SQL fenced + citation)
- **D5 Conservadorismo**: ratio Crítico/Alto — penaliza falsamente projetos genuinamente em risco

**Para decisões de release**, ler manualmente os outputs dos cenários abaixo de 8/10. O runner identifica candidatos a investigar; não substitui revisão.

## Ações follow-up por score

| Score agregado | Ação |
|---|---|
| ≥ 108/120 (90%) | Release |
| 96-107 (80-89%) | Identificar 1-3 cenários mais fracos, corrigir, re-correr |
| 84-95 (70-79%) | **NÃO release**. Investigar regressão. Comparar com resultado anterior |
| < 84 (< 70%) | Skill quebrada. Bisect das mudanças desde último resultado verde |

## Smoke test rápido (5-10 min)

Para "está minimamente OK?" antes de mudanças não-triviais:

```bash
npm run eval:smoke
```

Cobre 4 cenários cruzados:
- P01 — Audit completo (workflow das 7 fases)
- P04 — Performance (loading correto + SQL específico)
- P06 — RAG (template novo + reference técnica complexa)
- P11 — Hotel (few-shot por domínio não-SaaS)

Score ≥28/40 (70%) → continuar; menor → investigar antes de avançar.

## Resultados — onde ficam

Em [`tests/results/`](../results/). Ver [`tests/results/README.md`](../results/README.md) para retention policy.

## Futuro

- **LLM-as-judge** opcional (Claude avalia se output cobre findings esperados, em vez de regex match)
- **CI integration**: workflow GitHub Actions que corre smoke test em PR e bloqueia merge se score baixa
- **Diff contra última corrida** automatizado (mostrar cenários que pioraram)
- **Benchmark continuo** vs Claude vanilla a cada release (gráfico ao longo do tempo)

## Pré-requisitos

- Skill instalada (ver `INSTALL.md` na raiz)
- Claude Code aberto
- Projeto Supabase teste à mão (não precisa ser real — pode ser pasta vazia com alguns `*.sql` mínimos)

## Procedimento

### Passo 1 — Para cada prompt

1. Abrir [`prompts.md`](prompts.md) e escolher um cenário (P01–P12).
2. Configurar o **contexto descrito**: criar os ficheiros mínimos necessários no projeto teste (ex: para P01, criar `supabase/migrations/001_init.sql` com as tabelas mencionadas).
3. Colar o prompt do user no Claude Code.
4. **Não interromper**: deixar a skill correr até completar.
5. Guardar o output (copy-paste para ficheiro temporário).

### Passo 2 — Avaliação

Para cada cenário corrido:

1. Abrir [`expected.md`](expected.md) na secção correspondente.
2. Comparar output com checklist:
   - [ ] Ativação correta?
   - [ ] References apropriadas carregadas?
   - [ ] Achados esperados detetados?
   - [ ] Severidade calibrada?
   - [ ] Output acionável (SQL copy-paste, citações)?
3. Marcar **red flags** se observados.
4. Aplicar [`rubric.md`](rubric.md) → score 0-10.

### Passo 3 — Documentar resultados

Criar `tests/results/v<versão>-<YYYYMMDD>.md`:

```markdown
# Eval Results — v1.0.0 — 2026-05-11
Avaliador: <nome>
Tempo total: ~90 min

## Sumário
- Total: 102/120 (85%)
- Veredicto: A−

## Detalhe por prompt
| # | Prompt | D1 | D2 | D3 | D4 | D5 | Total | Red flags | Tempo (s) |
|---|---|---|---|---|---|---|---|---|---|
| P01 | Audit completo | 2 | 2 | 3 | 2 | 1 | 10 | — | 65 |
| P02 | Policy review | 2 | 2 | 2 | 2 | 1 | 9 | — | 22 |
| ... | | | | | | | | | |

## Cenários abaixo de 7 — investigar
- P11 (5/10): skill não usou few-shot do exemplo hotel. **Ação**: reforçar deteção em SKILL.md Fase 1.

## Comentários qualitativos
- P06 (RAG): output excelente mas demorou 95s — investigar.
- P11 (hotel): foi necessário pedir explicitamente "este é um sistema de booking" para ativar o few-shot.
```

### Passo 4 — Ações follow-up

- Score global < 90%? → identificar 2-3 cenários mais fracos, corrigir antes de release.
- Red flag específico repetido em ≥3 cenários? → ajustar regra em SKILL.md ou reference relevante.
- Cenário novo descoberto (skill funciona muito bem ou muito mal em algo não listado)? → adicionar a `prompts.md`.

## Smoke test rápido (5-10 min)

Quando só queres saber "está minimamente OK?":

| Prompt | Razão |
|---|---|
| **P01** | Audit completo — testa workflow das 7 fases |
| **P04** | Performance — testa loading correto + SQL específico |
| **P06** | RAG — testa template novo + reference técnica complexa |
| **P11** | Hotel — testa few-shot por domínio (não SaaS) |

Se os 4 dão ≥7/10, skill está OK. Se algum dá <5, **não fazer release** sem investigar.

## Antes de bump de versão

Correr os **12 cenários** completos. Score agregado:
- ≥ 90% (108/120) → release
- 80-89% → release com aviso no CHANGELOG
- < 80% → bloquear release

## Futuro — runner automatizado

Quando o runner existir (script Node ou Deno que invoca Anthropic SDK):

```bash
node tests/eval/runner.js --skill ./ --output tests/results/$(date +%Y%m%d).md
```

Resultado: tabela automática + comparação vs baseline anterior.

Por agora, **manual**. É lento (1-2h para 12 cenários) mas necessário até existir automação.
