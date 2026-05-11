# Rubric — Eval Suite

Critérios de pontuação para cada cenário em [`prompts.md`](prompts.md). Total **10 pontos por cenário**.

## Critérios (5 dimensões × 2 pontos)

### D1. Activation (2 pts)
A skill ativa quando devia?

| Pontuação | Descrição |
|---|---|
| 2 | Ativa automaticamente e usa o command correto (sem o user pedir explicitamente) |
| 1 | Ativa apenas com `/supabase-<cmd>` explícito, ou pede confirmação antes |
| 0 | Não ativa, ou ativa o command errado, ou aplica fluxo genérico de Claude |

### D2. Loading (2 pts)
Carrega as references certas?

| Pontuação | Descrição |
|---|---|
| 2 | Carrega exatamente as references esperadas (nem mais nem menos) |
| 1 | Carrega as references certas + 1-2 extras desnecessárias |
| 0 | Falta carregar reference crítica, ou carrega "tudo" (waste de contexto) |

### D3. Detection (3 pts)
Deteta os problemas que devia detetar?

| Pontuação | Descrição |
|---|---|
| 3 | Deteta todos os achados esperados + atribui severidade correta |
| 2 | Deteta todos os achados mas erra severidade num caso |
| 1 | Deteta a maioria mas falha um Crítico |
| 0 | Falha ≥2 achados Críticos ou Altos |

### D4. Quality (2 pts)
Output é acionável?

| Pontuação | Descrição |
|---|---|
| 2 | SQL/código copy-paste pronto; rollback documentado; cita `file:line` ou `schema.table` |
| 1 | SQL correto mas falta rollback ou citation |
| 0 | SQL com placeholders genéricos, ou pseudo-código |

### D5. Conservadorismo (1 pt)
Severidade calibrada?

| Pontuação | Descrição |
|---|---|
| 1 | Sem falsos positivos (Crítico só com exploit realista); sem inflar |
| 0 | Marca como Crítico problemas que são apenas Médio; ou inverte (Crítico → Baixo) |

## Score total → veredicto

| Score por prompt | Veredicto |
|---|---|
| 9-10 | **Excelente** — output production-grade |
| 7-8 | **Bom** — pequenas falhas mas utilizável |
| 5-6 | **Aceitável** — requer correção manual antes de aplicar |
| 3-4 | **Fraco** — output não é confiável |
| 0-2 | **Falha** — skill não está a funcionar para este cenário |

## Score agregado (12 prompts)

| Total / 120 | Versão da skill | Ação |
|---|---|---|
| ≥108 (90%) | **A solid** | Release |
| 96-107 (80-89%) | **A−** | Identificar e corrigir os 1-3 cenários mais fracos |
| 84-95 (70-79%) | **B+** | Regressão — não release antes de corrigir |
| <84 | **B ou pior** | Skill quebrada — investigar |

## Como tabular resultados

Criar `tests/results/v<versão>.md` com:

```markdown
# Eval Results — v1.0.0
Data: 2026-05-11
Avaliador: <nome>
Versão da skill: 1.0.0

## Sumário
- Total: 102/120 (85%)
- Veredicto: A−

## Por prompt
| # | Prompt | D1 | D2 | D3 | D4 | D5 | Total | Notas |
|---|---|---|---|---|---|---|---|---|
| P01 | Audit completo | 2 | 2 | 3 | 2 | 1 | 10 | OK |
| P02 | Policy review | 2 | 2 | 2 | 2 | 1 | 9 | severidade um nível abaixo |
| P03 | Migration safety | 2 | 1 | 3 | 2 | 1 | 9 | carregou refs extra |
| ... | | | | | | | | |

## Cenários abaixo de 7
- P11 hotel — não carregou exemplo dedicado (5/10). Falta few-shot detection.

## Ações
- [ ] Reforçar deteção de domínio "hotel/booking" em SKILL.md Fase 1
```

## Anti-patterns a procurar (red flags)

Durante avaliação, marcar com `[!!]` se observado:

- `[!!]` Skill **inventa** ficheiros / tabelas / policies que não existem no input
- `[!!]` Severidade Crítica para algo recuperável ou trivial
- `[!!]` Output sem citação de `file:line` ou `schema.table`
- `[!!]` Recomenda `service_role` no cliente
- `[!!]` Recomenda `USING (true)` sem aviso
- `[!!]` Sugere `DROP` sem confirmação
- `[!!]` Output em inglês quando user escreveu em pt-PT (e não pediu)
- `[!!]` Usa emojis sem o user ter pedido

Cada `[!!]` reduz o score do cenário em 1 ponto adicional.

## Critérios qualitativos (não pontuados, mas anotados)

Para cada cenário, anotar:
- **Tempo total** da skill (segundos até output completo)
- **Tokens gerados** (estimativa via contagem)
- **Refs carregadas** (lista explícita se observável)
- **Comentários do avaliador** (impressões qualitativas)

Estes não entram no score mas ajudam a identificar otimizações (ex: skill demora demasiado tempo em cenários simples).
