# Security Policy

## Reporting a vulnerability

This skill is a **defensive security tool** for Supabase projects. If you discover a vulnerability — in the skill itself or a security weakness that the skill **fails to detect** — please report it responsibly.

### Where to report

**Do NOT open a public GitHub issue for security vulnerabilities.**

Send a private report via one of:

1. **GitHub Security Advisories** (preferred): use the "Report a vulnerability" button in the Security tab of this repository.
2. **Email**: contact the maintainer (address in repository settings / GitHub profile).

### What to include

- Description of the issue
- Steps to reproduce (or a code sample / Supabase setup)
- Affected versions of the skill
- Suggested fix (if known)
- Your name/handle for credit (optional)

### Response timeline

| Stage | Target |
|---|---|
| Acknowledge receipt | 48 hours |
| Initial assessment | 5 business days |
| Fix + advisory (depending on severity) | 14-30 days |
| Public disclosure | Coordinated with reporter |

## Scope

### In scope

- **Skill content** that recommends insecure patterns (e.g., a reference suggests `USING (true)` without warning)
- **False negatives** — skill fails to detect a critical Supabase misconfiguration that should be in the heuristics catalog (`references/HEURISTICS.md`)
- **False positives** that mislead users into making projects less secure
- **Eval runner** vulnerabilities (`tests/eval/`) — secret leak, command injection, etc.
- **Install command** (`git clone`) — cloning from a malicious fork that impersonates this repo

### Out of scope

- Vulnerabilities in Supabase itself → report to [Supabase Security](https://supabase.com/security)
- Vulnerabilities in PostgreSQL → report to [PostgreSQL Security](https://www.postgresql.org/support/security/)
- Vulnerabilities in Anthropic SDK → report to [Anthropic](https://www.anthropic.com/security)
- Bugs that are not security-relevant → open a regular GitHub issue

## Coordinated disclosure

We follow **responsible disclosure**:

1. Reporter sends private report
2. Maintainer acknowledges and confirms the issue
3. Maintainer develops fix in a private branch
4. CVE assigned (if applicable)
5. Fix released
6. Security advisory published
7. Reporter credited (if they wish)

## Security considerations using this skill

The skill itself does **not execute code or queries** against your Supabase project. However:

- **Installation via git clone** writes to `~/.claude/skills/supabase/`. Always clone from the official repo URL (`github.com/antoniocostalopes/supabase-architect-skill`), not from forks you don't control.
- **The eval runner** (`tests/eval/runner.ts`) calls the Anthropic API using your `ANTHROPIC_API_KEY`. Treat the key like any other secret. Never commit `.env`.
- **Supabase MCP integration** (optional): if you enable the Supabase MCP server, **always use `--read-only` mode in production**. See `references/17-mcp-integration.md` for security rules.

## Hall of fame

Contributors who responsibly disclosed valid security issues:

<!-- Add entries here in format: -->
<!-- - YYYY-MM-DD — [@handle](https://github.com/handle) — brief description -->

_(Empty so far. Be the first!)_

## Updates to this policy

This policy may be revised. Material changes will be documented in `CHANGELOG.md`.
