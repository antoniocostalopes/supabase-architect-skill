# Instalação — Supabase Architect

Como instalar a skill no Claude Code. O método recomendado é **git clone** — 1 comando, updates triviais.

## Pré-requisitos

- **Claude Code** instalado (`claude --version`)
- **Git** instalado (`git --version`)
- (Opcional) **Supabase CLI** — `npm i -g supabase`
- (Opcional) **Supabase MCP** — ver [`references/17-mcp-integration.md`](references/17-mcp-integration.md)

---

## Método A — git clone global (recomendado)

A skill fica disponível em **todos os projetos**.

```bash
git clone https://github.com/antoniocostalopes/supabase-architect-skill.git \
  ~/.claude/skills/supabase
```

Windows (PowerShell):
```powershell
git clone https://github.com/antoniocostalopes/supabase-architect-skill.git `
  "$env:USERPROFILE\.claude\skills\supabase"
```

**Atualizar para nova versão:**
```bash
cd ~/.claude/skills/supabase && git pull
```

**Instalar versão específica (tag):**
```bash
git clone --branch v1.0.0 \
  https://github.com/antoniocostalopes/supabase-architect-skill.git \
  ~/.claude/skills/supabase
```

---

## Método B — git clone project-local

A skill fica disponível **apenas no projeto atual**. Útil para versionar a skill com o projeto ou isolar versões por repo.

```bash
# Dentro do repo do teu projeto
mkdir -p .claude/skills
git clone https://github.com/antoniocostalopes/supabase-architect-skill.git \
  .claude/skills/supabase
```

Adicionar ao `.gitignore` do projeto se não quiseres commitar a skill:
```
.claude/skills/supabase/
```

Ou commitar como **submodule** (ver Método D).

---

## Método C — curl one-liner (sem git)

Para instalar sem clonar o repo completo — faz download do zip da release mais recente.

```bash
# macOS / Linux
curl -fsSL \
  https://github.com/antoniocostalopes/supabase-architect-skill/archive/refs/heads/main.tar.gz \
  | tar -xz --strip-components=1 -C ~/.claude/skills/supabase \
    --exclude='*/tests/eval/node_modules' \
    --exclude='*/.git'
```

Para uma release específica (ex: v1.0.0):
```bash
curl -fsSL \
  https://github.com/antoniocostalopes/supabase-architect-skill/archive/refs/tags/v1.0.0.tar.gz \
  | tar -xz --strip-components=1 -C ~/.claude/skills/supabase
```

---

## Método D — git submodule (avançado)

Para equipas que querem **sincronizar a skill via o próprio repo** do projeto.

```bash
# Adicionar como submodule
git submodule add \
  https://github.com/antoniocostalopes/supabase-architect-skill.git \
  .claude/skills/supabase

# Fixar numa versão específica
cd .claude/skills/supabase && git checkout v1.0.0 && cd -
git add .claude/skills/supabase && git commit -m "chore: pin supabase-architect skill to v1.0.0"
```

Outros elementos da equipa:
```bash
git submodule update --init --recursive
```

Atualizar:
```bash
cd .claude/skills/supabase && git pull && cd -
git add .claude/skills/supabase && git commit -m "chore: update supabase-architect skill"
```

---

## Verificação pós-instalação

Após qualquer método, confirmar:

```bash
# Ficheiro principal presente
ls ~/.claude/skills/supabase/SKILL.md

# Versão instalada
grep -m1 "^\## \[" ~/.claude/skills/supabase/CHANGELOG.md

# Número de commands
ls ~/.claude/skills/supabase/commands/supabase-*.md | wc -l
# Esperado: 12
```

Depois reiniciar o Claude Code. Ao digitar `/`, os comandos `/supabase-*` devem aparecer.

---

## Atualização

### git clone (Método A ou B)
```bash
cd ~/.claude/skills/supabase && git pull
```

### curl (Método C)
Repetir o comando de instalação. A pasta existente é sobrescrita.

> **Nota**: se fizeste alterações locais à skill, o `git pull` vai conflitar. Usar `git stash` antes ou fork + clone do teu fork.

---

## Desinstalar

```bash
# Global
rm -rf ~/.claude/skills/supabase

# Project-local
rm -rf .claude/skills/supabase
```

---

## Configurar Supabase MCP (opcional)

Para a skill ler o schema do teu projeto diretamente:

```json
// .claude/mcp.json no teu projecto
{
  "mcpServers": {
    "supabase": {
      "command": "npx",
      "args": [
        "-y",
        "@supabase/mcp-server-supabase@latest",
        "--read-only",
        "--project-ref=<O_TEU_PROJECT_REF>"
      ],
      "env": {
        "SUPABASE_ACCESS_TOKEN": "<O_TEU_TOKEN>"
      }
    }
  }
}
```

Detalhes completos: [`references/17-mcp-integration.md`](references/17-mcp-integration.md).

---

## Troubleshooting

### A skill não aparece no Claude Code
1. Confirmar que `~/.claude/skills/supabase/SKILL.md` existe
2. Confirmar que o frontmatter é válido: `head -3 ~/.claude/skills/supabase/SKILL.md`
3. Reiniciar Claude Code

### `git clone` falha (pasta já existe)
```bash
rm -rf ~/.claude/skills/supabase
git clone https://github.com/antoniocostalopes/supabase-architect-skill.git ~/.claude/skills/supabase
```

### MCP não conecta
1. Testar token: `npx -y @supabase/mcp-server-supabase@latest --help`
2. Confirmar que `--project-ref` é o ref correto (encontrar no URL do projecto Supabase)
