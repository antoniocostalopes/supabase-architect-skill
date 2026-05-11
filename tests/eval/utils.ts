// utils.ts — helpers para o eval runner
// Copyright (c) 2026 António Lopes. Licensed under MIT.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export type Prompt = {
  id: string;          // "P01"
  title: string;       // "Audit completo (SaaS B2B)"
  context: string;     // bloco de contexto, sem markdown
  userMessage: string; // pedido do user
  expectedActivation: string; // skill/command esperado
};

export type ExpectedSignals = {
  id: string;
  activation: string[];        // strings/regex que devem aparecer
  references: string[];        // references que devem ser mencionadas/carregadas
  template: string | null;     // template esperado
  findings: string[];          // achados-chave esperados (regex / keywords)
  redFlags: string[];          // strings que se aparecerem reduzem score
};

export type Score = {
  d1Activation: number;   // 0-2
  d2Loading: number;      // 0-2
  d3Detection: number;    // 0-3
  d4Quality: number;      // 0-2
  d5Conservatism: number; // 0-1
  redFlagsHit: number;    // penalidade adicional
  total: number;          // 0-10 (após penalidades)
};

export type RunResult = {
  prompt: Prompt;
  output: string;
  score: Score;
  observations: string[];
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
};

const SKILL_ROOT = join(import.meta.dirname ?? __dirname, '..', '..');

/** Lê o ficheiro SKILL.md para usar como system prompt principal */
export async function loadSkillSystemPrompt(): Promise<string> {
  const skillMd = await readFile(join(SKILL_ROOT, 'SKILL.md'), 'utf-8');
  const heuristics = await readFile(join(SKILL_ROOT, 'references', 'HEURISTICS.md'), 'utf-8');
  const mindset = await readFile(join(SKILL_ROOT, 'references', '00-mindset-arquiteto.md'), 'utf-8');
  const vulns = await readFile(join(SKILL_ROOT, 'references', '10-common-vulnerabilities.md'), 'utf-8');

  return [
    '# Skill: Supabase Architect',
    '',
    '## Skill core',
    skillMd,
    '',
    '## Always loaded: Mindset',
    mindset,
    '',
    '## Always loaded: Common vulnerabilities',
    vulns,
    '',
    '## Always loaded: Heuristics catalog',
    heuristics,
  ].join('\n');
}

/** Parse de prompts.md — extrai os 12 cenários P01..P12 */
export async function parsePrompts(): Promise<Prompt[]> {
  const content = await readFile(join(SKILL_ROOT, 'tests', 'eval', 'prompts.md'), 'utf-8');
  const prompts: Prompt[] = [];

  // Split por header "## P01 — ..."
  const sections = content.split(/^## (P\d{2})\s+—\s+(.+)$/gm).slice(1);
  for (let i = 0; i < sections.length; i += 3) {
    const id = sections[i];
    const title = sections[i + 1]?.trim() ?? '';
    const body = sections[i + 2] ?? '';
    if (!id || !id.match(/^P\d{2}$/)) continue;

    const contextMatch = body.match(/\*\*Contexto\*\*:?\s*([\s\S]+?)(?=\*\*Prompt do user\*\*|\*\*Espera-se|$)/);
    const userMatch = body.match(/\*\*Prompt do user\*\*:?\s*>?\s*"?([\s\S]+?)"?(?=\n\n\*\*|$)/);
    const activationMatch = body.match(/\*\*Espera-se que ative\*\*:?\s*([\s\S]+?)(?=\n\n##|$|---)/);

    prompts.push({
      id,
      title,
      context: contextMatch?.[1]?.trim() ?? '',
      userMessage: userMatch?.[1]?.trim().replace(/^"|"$/g, '') ?? '',
      expectedActivation: activationMatch?.[1]?.trim() ?? '',
    });
  }

  return prompts;
}

/** Parse de expected.md — extrai sinais por cenário */
export async function parseExpected(): Promise<Map<string, ExpectedSignals>> {
  const content = await readFile(join(SKILL_ROOT, 'tests', 'eval', 'expected.md'), 'utf-8');
  const result = new Map<string, ExpectedSignals>();

  const sections = content.split(/^## (P\d{2})\s+—\s+(.+)$/gm).slice(1);
  for (let i = 0; i < sections.length; i += 3) {
    const id = sections[i];
    const body = sections[i + 2] ?? '';
    if (!id || !id.match(/^P\d{2}$/)) continue;

    const activation = extractListAfter(body, /\*\*Ativação esperada\*\*/i);
    const references = extractListAfter(body, /\*\*References? a carregar\*\*/i);
    const findings = extractListAfter(body, /\*\*(Achados? a detetar|Output esperado|Achados? esperados?)\*\*/i);
    const redFlags = extractListAfter(body, /\*\*Red flags\*\*/i);
    const templateMatch = body.match(/\*\*Template esperado\*\*:?\s*`?([^`\n]+)`?/i);

    result.set(id, {
      id,
      activation,
      references,
      template: templateMatch?.[1]?.trim() ?? null,
      findings,
      redFlags,
    });
  }

  return result;
}

function extractListAfter(body: string, headerRe: RegExp): string[] {
  const m = body.match(new RegExp(headerRe.source + '[\\s\\S]+?(?=\\n\\n\\*\\*|\\n\\n##|---|$)', 'i'));
  if (!m) return [];
  const items: string[] = [];
  for (const line of m[0].split('\n').slice(1)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('-') || t.startsWith('*')) {
      const cleaned = t.replace(/^[-*]\s*\[?[ x]?\]?\s*/, '').trim();
      if (cleaned) items.push(cleaned);
    } else if (t.startsWith('`')) {
      items.push(t.replace(/`/g, ''));
    }
  }
  return items;
}

/** Scoring automático (heurísticas; complementar com revisão manual para D4/D5) */
export function autoScore(output: string, expected: ExpectedSignals): Score {
  const lower = output.toLowerCase();

  // D1 Activation — procurar mention de command/skill correto
  let d1 = 0;
  for (const a of expected.activation) {
    const needle = a.toLowerCase();
    if (lower.includes(needle.toLowerCase())) { d1 = 2; break; }
    if (needle.includes('/supabase-') && lower.includes(needle.split(' ')[0].toLowerCase())) { d1 = Math.max(d1, 1); }
  }

  // D2 Loading — procurar mentions a references esperadas
  const refsHit = expected.references.filter((r) => lower.includes(r.toLowerCase().split(/[^a-z0-9-]/).filter(Boolean).join('-')));
  let d2 = 0;
  if (expected.references.length > 0) {
    const pct = refsHit.length / expected.references.length;
    d2 = pct >= 0.75 ? 2 : pct >= 0.4 ? 1 : 0;
  } else { d2 = 2; } // se não há expected refs, considerar OK

  // D3 Detection — procurar findings esperados
  const findingsHit = expected.findings.filter((f) => {
    const keywords = f.toLowerCase().match(/\b[a-z_]{4,}\b/g) ?? [];
    return keywords.some((k) => lower.includes(k));
  });
  let d3 = 0;
  if (expected.findings.length > 0) {
    const pct = findingsHit.length / expected.findings.length;
    d3 = pct >= 0.75 ? 3 : pct >= 0.5 ? 2 : pct >= 0.25 ? 1 : 0;
  } else { d3 = 3; }

  // D4 Quality — heurística: tem SQL fenced block? Tem rollback?
  const hasSql = /```sql/i.test(output);
  const hasRollback = /rollback|down\.sql|reversible/i.test(output);
  const hasCitation = /[a-z_0-9.]+:[0-9]+|pg_[a-z]+|public\.[a-z_]+/i.test(output);
  let d4 = 0;
  if (hasSql && hasCitation) d4 = 2;
  else if (hasSql || hasCitation) d4 = 1;
  if (!hasRollback && /(drop|alter|delete|update)/i.test(output)) d4 = Math.max(0, d4 - 1);

  // D5 Conservadorismo — não atribuir Crítico em demasia
  const criticalCount = (output.match(/cr[ií]tico/gi) ?? []).length;
  const highCount = (output.match(/\balto\b/gi) ?? []).length;
  const ratio = criticalCount / Math.max(1, criticalCount + highCount);
  const d5 = ratio > 0.7 ? 0 : 1;

  // Red flags
  const redFlagsHit = expected.redFlags.filter((rf) => {
    const keywords = rf.toLowerCase().match(/\b[a-z_]{4,}\b/g) ?? [];
    return keywords.length > 0 && keywords.every((k) => lower.includes(k));
  }).length;

  const subtotal = d1 + d2 + d3 + d4 + d5;
  const total = Math.max(0, subtotal - redFlagsHit);

  return {
    d1Activation: d1,
    d2Loading: d2,
    d3Detection: d3,
    d4Quality: d4,
    d5Conservatism: d5,
    redFlagsHit,
    total,
  };
}

/** Formata duração em ms para "Xs" ou "Xm Ys" */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Veredicto agregado a partir de score total */
export function verdict(total: number, max: number): string {
  const pct = (total / max) * 100;
  if (pct >= 90) return 'A solid — release';
  if (pct >= 80) return 'A− — corrigir 1-3 cenários mais fracos';
  if (pct >= 70) return 'B+ — regressão, NÃO release';
  return 'B ou pior — skill quebrada, investigar';
}

/** Gera path do ficheiro de resultados para a corrida atual */
export function resultsPath(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  return join(SKILL_ROOT, 'tests', 'results', `${ts}.md`);
}
