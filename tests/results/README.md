# Eval Results

Resultados das corridas do eval runner. Ficheiros gerados automaticamente pelo `tests/eval/runner.ts`.

## Convenção de nomes

```
<YYYY-MM-DD-HH-mm>.md             # corrida normal (com skill)
<YYYY-MM-DD-HH-mm>.baseline.md    # corrida sem skill (vanilla)
```

## Como interpretar

Cada ficheiro contém:

- **Sumário** com score total, veredicto, custo (tokens), tempo
- **Tabela por prompt** com breakdown das 5 dimensões D1-D5 + red flags
- **Cenários < 7/10** com observações + excerto do output
- **Notas** sobre limitações do scoring automático

## Veredicto por percentagem

| Score % | Veredicto | Ação |
|---|---|---|
| ≥ 90% | A solid | Release |
| 80-89% | A− | Corrigir 1-3 cenários mais fracos |
| 70-79% | B+ | Regressão — NÃO release |
| < 70% | B ou pior | Investigar — skill quebrada |

## Comparação com baseline

Para validar que a skill **acrescenta valor** vs Claude vanilla:

```bash
npm run eval:compare
```

Gera duas corridas:
- `<timestamp>.md` (com skill)
- `<timestamp>.baseline.md` (sem skill)

Comparar score total. Ganho típico esperado: **40-60 pontos** em 120 (do baseline para skill carregada).

## Retenção

Manter:
- Último resultado por versão major/minor (`v1.0.0-final.md`)
- Comparação baseline mais recente
- Resultados que documentam regressão (para post-mortem)

Apagar:
- Corridas iterativas durante desenvolvimento (após análise)

## Privacidade

Output de prompts não contém PII (são cenários sintéticos), mas pode conter texto SQL completo. Não há razão para fazer redaction. Resultados podem ser commitados ao repo.

**Exceção**: corridas contra projeto real (com schema do cliente) — esses ficam fora do repo, em pasta gitignored.
