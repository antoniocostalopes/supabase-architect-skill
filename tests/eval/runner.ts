#!/usr/bin/env tsx
// runner.ts — Eval automatizado da skill Supabase Architect
// Copyright (c) 2026 António Lopes. Licensed under MIT.
//
// Uso:
//   ANTHROPIC_API_KEY=sk-ant-... npx tsx runner.ts [--only P01,P04] [--model claude-opus-4-7] [--baseline]
//
// Flags:
//   --only <ids>       Correr só estes prompts (comma-separated)
//   --model <id>       Override do modelo Anthropic (default: claude-sonnet-4-6)
//   --baseline         Correr sem o system prompt da skill (benchmark vanilla)
//   --no-write         Não gravar ficheiro de resultados
//
// Saída:
//   tests/results/<YYYY-MM-DD-HH-mm>.md (e variante .baseline.md se --baseline)

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import {
  loadSkillSystemPrompt,
  parsePrompts,
  parseExpected,
  autoScore,
  fmtDuration,
  verdict,
  resultsPath,
  type RunResult,
  type Prompt,
  type Score,
} from './utils.js';

type Args = {
  only?: string[];
  model: string;
  baseline: boolean;
  write: boolean;
};

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Args = { model: 'claude-sonnet-4-6', baseline: false, write: true };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--only') out.only = args[++i]?.split(',').map((s) => s.trim()) ?? [];
    else if (a === '--model') out.model = args[++i] ?? out.model;
    else if (a === '--baseline') out.baseline = true;
    else if (a === '--no-write') out.write = false;
    else if (a === '--help' || a === '-h') {
      console.log(`Eval runner para Supabase Architect.

Uso: npx tsx runner.ts [flags]

Flags:
  --only <ids>      Correr apenas estes prompts (ex: --only P01,P04,P11)
  --model <id>      Override do modelo Anthropic (default: claude-sonnet-4-6)
  --baseline        Correr sem skill (vanilla Claude) para comparação
  --no-write        Imprimir relatório no stdout em vez de gravar
  --help            Esta ajuda

Requer ANTHROPIC_API_KEY no environment.`);
      process.exit(0);
    }
  }
  return out;
}

async function runPrompt(
  client: Anthropic,
  prompt: Prompt,
  systemPrompt: string | null,
  model: string,
): Promise<{ output: string; durationMs: number; tokensIn: number; tokensOut: number }> {
  const userContent = prompt.context
    ? `Contexto:\n${prompt.context}\n\n---\n\nUtilizador pergunta:\n${prompt.userMessage}`
    : prompt.userMessage;

  const start = Date.now();
  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: systemPrompt ?? undefined,
    messages: [{ role: 'user', content: userContent }],
  });

  const durationMs = Date.now() - start;
  const output = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('\n');

  return {
    output,
    durationMs,
    tokensIn: response.usage.input_tokens,
    tokensOut: response.usage.output_tokens,
  };
}

function renderReport(results: RunResult[], args: Args): string {
  const totalScore = results.reduce((s, r) => s + r.score.total, 0);
  const maxScore = results.length * 10;
  const totalTokensIn = results.reduce((s, r) => s + r.tokensIn, 0);
  const totalTokensOut = results.reduce((s, r) => s + r.tokensOut, 0);
  const totalMs = results.reduce((s, r) => s + r.durationMs, 0);

  const lines: string[] = [];
  lines.push(`# Eval Results — ${args.baseline ? 'Baseline (vanilla Claude)' : 'Skill v1.0.0'}`);
  lines.push('');
  lines.push(`- Data: ${new Date().toISOString()}`);
  lines.push(`- Modelo: \`${args.model}\``);
  lines.push(`- Modo: ${args.baseline ? '**BASELINE** (sem skill carregada)' : 'com skill'}`);
  lines.push(`- Cenários: ${results.length}/${results.length}`);
  lines.push('');
  lines.push('## Sumário');
  lines.push('');
  lines.push(`- **Score total**: ${totalScore}/${maxScore} (${((totalScore / maxScore) * 100).toFixed(1)}%)`);
  lines.push(`- **Veredicto**: ${verdict(totalScore, maxScore)}`);
  lines.push(`- **Tokens (in/out)**: ${totalTokensIn.toLocaleString()} / ${totalTokensOut.toLocaleString()}`);
  lines.push(`- **Tempo total**: ${fmtDuration(totalMs)}`);
  lines.push('');
  lines.push('## Detalhe por prompt');
  lines.push('');
  lines.push('| # | Prompt | D1 | D2 | D3 | D4 | D5 | RF | Total | Tempo | Tokens in/out |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const s = r.score;
    lines.push(
      `| ${r.prompt.id} | ${truncate(r.prompt.title, 40)} | ${s.d1Activation} | ${s.d2Loading} | ${s.d3Detection} | ${s.d4Quality} | ${s.d5Conservatism} | ${s.redFlagsHit > 0 ? `-${s.redFlagsHit}` : '0'} | **${s.total}** | ${fmtDuration(r.durationMs)} | ${r.tokensIn}/${r.tokensOut} |`
    );
  }
  lines.push('');

  const weakest = [...results].sort((a, b) => a.score.total - b.score.total).slice(0, 3);
  if (weakest.some((r) => r.score.total < 7)) {
    lines.push('## Cenários < 7 — investigar');
    lines.push('');
    for (const r of weakest.filter((r) => r.score.total < 7)) {
      lines.push(`### ${r.prompt.id} — ${r.prompt.title} (${r.score.total}/10)`);
      lines.push('');
      lines.push(`**Score breakdown**: D1=${r.score.d1Activation} D2=${r.score.d2Loading} D3=${r.score.d3Detection} D4=${r.score.d4Quality} D5=${r.score.d5Conservatism} (red flags: ${r.score.redFlagsHit})`);
      lines.push('');
      lines.push('**Observações**:');
      for (const obs of r.observations) lines.push(`- ${obs}`);
      lines.push('');
      lines.push('<details><summary>Output (excerto)</summary>');
      lines.push('');
      lines.push('```markdown');
      lines.push(truncate(r.output, 1500));
      lines.push('```');
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
  }

  lines.push('## Notas');
  lines.push('');
  lines.push('Scoring é **automático e heurístico** (keyword/regex). Para avaliação rigorosa, ainda é necessária review manual com `rubric.md`:');
  lines.push('');
  lines.push('- D1 mede ativação correta — pode dar falso positivo se o output menciona o command sem o usar');
  lines.push('- D2 mede menções a references — não verifica se foi de facto carregada');
  lines.push('- D3 procura keywords dos findings esperados — pode falhar em sinónimos');
  lines.push('- D4 verifica SQL/citation/rollback — heurística simples');
  lines.push('- D5 conta ratio Crítico/Alto — falsamente penaliza projetos genuinamente críticos');
  lines.push('');
  lines.push('Resultado deve ser confrontado com leitura manual antes de tomar decisões de release.');
  lines.push('');

  if (args.baseline) {
    lines.push('## Baseline note');
    lines.push('');
    lines.push('Esta corrida foi feita **sem** a skill carregada. Score baixo aqui + score alto na corrida com skill = sinal de que a skill efetivamente acrescenta valor.');
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('Copyright © 2026 António Lopes. Licensed under MIT.');

  return lines.join('\n');
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY environment variable is required.');
    console.error('Get one at https://console.anthropic.com/');
    process.exit(1);
  }

  console.log('⏳ Loading skill + prompts + expected signals...');
  const [systemPrompt, allPrompts, expected] = await Promise.all([
    loadSkillSystemPrompt(),
    parsePrompts(),
    parseExpected(),
  ]);

  let prompts = allPrompts;
  if (args.only && args.only.length > 0) {
    prompts = allPrompts.filter((p) => args.only!.includes(p.id));
    console.log(`📋 Running ${prompts.length} prompts: ${prompts.map((p) => p.id).join(', ')}`);
  } else {
    console.log(`📋 Running all ${prompts.length} prompts`);
  }

  console.log(`🤖 Model: ${args.model}`);
  console.log(`🎯 Mode: ${args.baseline ? 'BASELINE (no skill)' : 'with skill'}`);
  console.log('');

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const results: RunResult[] = [];

  for (const prompt of prompts) {
    process.stdout.write(`▶  ${prompt.id} ${prompt.title.padEnd(40)} `);
    try {
      const exec = await runPrompt(
        client,
        prompt,
        args.baseline ? null : systemPrompt,
        args.model,
      );

      const exp = expected.get(prompt.id);
      const score: Score = exp
        ? autoScore(exec.output, exp)
        : {
            d1Activation: 0,
            d2Loading: 0,
            d3Detection: 0,
            d4Quality: 0,
            d5Conservatism: 0,
            redFlagsHit: 0,
            total: 0,
          };

      const observations: string[] = [];
      if (!exp) observations.push('Sem `expected.md` para este prompt — score = 0');
      if (score.d1Activation < 2) observations.push('Ativação possivelmente incompleta');
      if (score.d3Detection < 2) observations.push('Findings esperados pouco cobertos');
      if (score.d4Quality < 2) observations.push('Output sem SQL claro ou sem rollback documentado');
      if (score.redFlagsHit > 0) observations.push(`${score.redFlagsHit} red flag(s) detetadas`);

      results.push({
        prompt,
        output: exec.output,
        score,
        observations,
        durationMs: exec.durationMs,
        tokensIn: exec.tokensIn,
        tokensOut: exec.tokensOut,
      });

      console.log(`${score.total}/10  ${fmtDuration(exec.durationMs)}  ${exec.tokensOut} tok`);
    } catch (err) {
      console.log('❌ FAILED');
      console.error(`   ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log('');
  const report = renderReport(results, args);

  if (args.write) {
    const path = resultsPath().replace(/\.md$/, args.baseline ? '.baseline.md' : '.md');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, report, 'utf-8');
    console.log(`✓ Report written: ${path}`);
  } else {
    console.log(report);
  }

  const totalScore = results.reduce((s, r) => s + r.score.total, 0);
  const maxScore = results.length * 10;
  console.log('');
  console.log(`Total: ${totalScore}/${maxScore} (${((totalScore / maxScore) * 100).toFixed(1)}%)`);
  console.log(`Veredicto: ${verdict(totalScore, maxScore)}`);

  // Exit code reflete o veredicto — útil em CI
  const pct = (totalScore / maxScore) * 100;
  process.exit(pct >= 80 ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
