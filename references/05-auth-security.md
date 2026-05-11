# Supabase Auth Security

Como auditar e construir auth seguro em Supabase, do lado da DB e do lado da app.

## Modelo de auth do Supabase

- `auth.users` — tabela gerida pelo Supabase Auth (não tocar diretamente)
- `auth.uid()` — UUID do utilizador autenticado na request atual
- `auth.jwt()` — payload completo do JWT como `jsonb`
- `auth.role()` — `anon` ou `authenticated` (não confundir com role de negócio)
- `auth.email()` — email do utilizador autenticado

## Profile pattern

Não estender `auth.users` diretamente. Criar `public.profiles` 1:1.

```sql
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name text,
  avatar_url text,
  username text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles_select_self_or_org_members" ON public.profiles
FOR SELECT TO authenticated
USING (
  id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM public.memberships m1
    JOIN public.memberships m2 ON m1.organization_id = m2.organization_id
    WHERE m1.user_id = auth.uid() AND m2.user_id = profiles.id
  )
);

CREATE POLICY "profiles_update_self" ON public.profiles
FOR UPDATE TO authenticated
USING (id = auth.uid())
WITH CHECK (id = auth.uid());

-- Trigger: criar profile automaticamente quando user sign-up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, avatar_url)
  VALUES (
    NEW.id,
    NEW.raw_user_meta_data ->> 'full_name',
    NEW.raw_user_meta_data ->> 'avatar_url'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
```

## Configuração crítica em Supabase Dashboard

### Auth → Providers
- **Email/password**: confirmar se "Confirm email" está ativo em produção
- **OAuth providers**: verificar redirect URLs (não permitir wildcards perigosos)
- **Magic link**: validar TTL (default 1h é razoável)
- **Phone auth**: rate limiting é mandatório (caro se atacado)

### Auth → Settings
- **JWT Expiry**: 3600s (1h) para session token; refresh token configurar TTL razoável
- **Refresh Token Rotation**: ATIVAR (rotação automática)
- **Reuse Detection**: ATIVAR (revoga toda a árvore se detetar reuse)
- **Password requirements**: mínimo 12 chars; ativar checks de pwned
- **Email change requires confirmation**: ATIVAR
- **Disable Email/Password Sign-Ups**: avaliar consoante produto (B2B SaaS muitas vezes só permite via convite)

### Auth → URL Configuration
- **Site URL**: domínio canónico em produção (sem `localhost`)
- **Additional Redirect URLs**: lista exaustiva; sem wildcards inseguros tipo `https://*.example.com`
- **PKCE flow**: ativado para apps SPA / mobile

### Auth → Rate Limits
Validar e endurecer:
- Sign-ups por hora por IP
- Sign-ins por hora por IP
- OTP requests
- Password reset

## Service role — regras absolutas

```ts
// ❌ NUNCA
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY!
)

// ✅ Só em código server-only, sem prefixo NEXT_PUBLIC_
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
)
```

### Onde service_role é aceitável
- Edge Functions (após validar JWT do user)
- Server Route Handlers / Server Actions / API routes que correm em runtime Node
- Workers / cron jobs
- Scripts admin one-off

### Onde service_role é proibido
- Qualquer ficheiro que vá para o bundle do browser
- Qualquer route que devolva HTML pré-renderizado sem isolamento
- Variáveis com prefixo `NEXT_PUBLIC_`, `VITE_`, `PUBLIC_`, `EXPO_PUBLIC_`

### Padrão correto em Edge Function
```ts
import { createClient } from 'npm:@supabase/supabase-js@2'

Deno.serve(async (req) => {
  // 1. Validar auth do user
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return new Response('Unauthorized', { status: 401 })

  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } }
  )
  const { data: { user } } = await userClient.auth.getUser()
  if (!user) return new Response('Unauthorized', { status: 401 })

  // 2. Validar permissão lógica (com userClient, RLS aplicada)
  const { data: membership } = await userClient
    .from('memberships').select('role')
    .eq('user_id', user.id)
    .eq('organization_id', orgId)
    .eq('is_active', true)
    .single()

  if (!membership || !['owner','admin'].includes(membership.role)) {
    return new Response('Forbidden', { status: 403 })
  }

  // 3. Agora sim, usar admin client para operação privilegiada
  const adminClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } }
  )
  // ... operação ...
})
```

## SSR / Next.js — padrão recomendado (@supabase/ssr)

```ts
// utils/supabase/server.ts
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export function createClient() {
  const cookieStore = cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,  // anon, nunca service_role
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options))
          } catch { /* called from Server Component */ }
        },
      },
    }
  )
}
```

### Middleware obrigatório (refresh de sessão)

Sem middleware a refrescar a sessão, o user vai ver expiry intermitentes.

```ts
// middleware.ts
import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request })
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return request.cookies.getAll() },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options))
        },
      },
    }
  )

  // Sempre chamar getUser() (não getSession) para validação real
  const { data: { user } } = await supabase.auth.getUser()

  // Redirect rules
  if (!user && request.nextUrl.pathname.startsWith('/dashboard')) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
```

**Crítico**: usar `getUser()` (valida JWT contra o servidor) e **não** `getSession()` (lê cookie sem revalidar). `getSession()` aceita um cookie forjado em SSR.

## Custom claims e roles

Para evitar consultar `memberships` em cada policy:

```sql
-- Hook chamado a cada emissão de JWT
CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE
AS $$
DECLARE
  claims jsonb := event->'claims';
  user_id uuid := (event->>'user_id')::uuid;
  user_orgs jsonb;
  current_org uuid;
BEGIN
  -- Lista de orgs do user
  SELECT jsonb_agg(jsonb_build_object('id', organization_id, 'role', role))
  INTO user_orgs
  FROM public.memberships
  WHERE user_id = (event->>'user_id')::uuid AND is_active = true;

  -- Org "ativa" (última usada, ou primeira)
  SELECT organization_id INTO current_org
  FROM public.memberships
  WHERE user_id = (event->>'user_id')::uuid AND is_active = true
  ORDER BY joined_at DESC LIMIT 1;

  claims := jsonb_set(claims, '{app_metadata,orgs}', coalesce(user_orgs, '[]'::jsonb));
  IF current_org IS NOT NULL THEN
    claims := jsonb_set(claims, '{app_metadata,current_org}', to_jsonb(current_org));
  END IF;

  event := jsonb_set(event, '{claims}', claims);
  RETURN event;
END;
$$;

-- Permissions
GRANT EXECUTE ON FUNCTION public.custom_access_token_hook TO supabase_auth_admin;
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook FROM authenticated, anon, public;
```

Activar em Dashboard → Auth → Hooks → Custom Access Token.

Uso em policy:
```sql
USING (
  organization_id = (auth.jwt() -> 'app_metadata' ->> 'current_org')::uuid
)
```

**Cuidado**: claims só atualizam em refresh do token. Mudança de membership pode demorar até ao próximo refresh para refletir.

## Detecção de padrões inseguros (grep checklist)

```
NEXT_PUBLIC_.*SERVICE_ROLE       # service_role exposto
VITE_.*SERVICE_ROLE              # idem
PUBLIC_.*SERVICE_ROLE            # idem
getSession\(\)                   # usar getUser() em SSR
supabase\.auth\.user             # API legacy
@supabase/auth-helpers           # legacy (preferir @supabase/ssr)
admin\.createUser\(.*service     # admin create sem validação
adminAuthClient.*delete          # delete de users sem auditoria
.from\('auth.users'\)            # leitura direta de auth.users (preferir profiles)
```

## Auditoria de endpoints auth

Para cada Edge Function / route handler que toca dados:

- [ ] Valida `Authorization: Bearer` header?
- [ ] Usa `getUser()` (valida contra servidor) e não `getSession()`?
- [ ] Aplica RLS através de `userClient`, não de `adminClient`?
- [ ] Se usa `adminClient`, valida ownership/membership antes?
- [ ] Não loga JWT, password, tokens?
- [ ] Rate-limited (Supabase platform rate limiting OU app-level)?
- [ ] CORS configurado para domínios permitidos (não `*`)?

## Auditoria de schema auth

```sql
-- 1. profiles cobre todos os users
SELECT u.id FROM auth.users u
LEFT JOIN public.profiles p ON p.id = u.id
WHERE p.id IS NULL;

-- 2. Trigger handle_new_user existe
SELECT tgname FROM pg_trigger WHERE tgrelid = 'auth.users'::regclass;

-- 3. Functions SECURITY DEFINER têm search_path fixo
SELECT n.nspname, p.proname, p.prosecdef,
       array_to_string(p.proconfig, ', ') AS config
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.prosecdef = true
  AND n.nspname = 'public'
  AND (p.proconfig IS NULL OR NOT 'search_path' = ANY(
    array(SELECT split_part(unnest(p.proconfig),'=',1))
  ));

-- 4. Privilege grants em auth schema
SELECT grantee, privilege_type
FROM information_schema.table_privileges
WHERE table_schema = 'auth'
  AND grantee IN ('anon','authenticated');
```

## Vulnerabilidades específicas

### Email enumeration
`/auth/v1/recover` pode revelar se um email existe. Mitigação: respostas idênticas para "existe" e "não existe".

### Token leakage em URLs
Magic link `?token=...` aparece em logs e Referer. Mitigação: `flow_type: 'pkce'`.

### CSRF em flows OAuth
Verificar que o callback valida `state` parameter (PKCE faz isto automaticamente).

### Session fixation
Após login, o cookie deve mudar (rotação). `@supabase/ssr` faz isto.

### IDOR em admin endpoints
```ts
// ❌ ERRADO
await supabaseAdmin.auth.admin.deleteUser(req.body.user_id)

// ✅ Verificar autorização primeiro
const { data: caller } = await userClient.auth.getUser()
if (!isPlatformAdmin(caller.id)) return forbidden()
await supabaseAdmin.auth.admin.deleteUser(req.body.user_id)
```

## MFA / TOTP

Supabase Auth suporta multi-factor (TOTP via app autenticadora, e WebAuthn em planos avançados). MFA é representado por dois níveis de assurance:

- **AAL1** — autenticado com password / OAuth / magic link
- **AAL2** — completou um factor adicional (TOTP)

### Configuração (Dashboard)
- Auth → Providers → Multi-Factor → enable
- Settings → Auth → MFA → enforcement: optional / required-for-sensitive

### Enrollment do utilizador
```ts
// 1. Iniciar enrollment
const { data: factor, error } = await supabase.auth.mfa.enroll({
  factorType: 'totp',
  friendlyName: 'Authenticator',
})
// factor.id, factor.totp.qr_code (mostrar ao user)

// 2. User scaneia QR + escreve código
const { data: challenge } = await supabase.auth.mfa.challenge({ factorId: factor.id })
const { error: verifyErr } = await supabase.auth.mfa.verify({
  factorId: factor.id,
  challengeId: challenge.id,
  code: '123456',
})
```

### Forçar AAL2 em RLS

Detectar AAL atual:
```sql
-- aal: 'aal1' ou 'aal2'
SELECT (auth.jwt() ->> 'aal');
```

Restringir tabelas sensíveis a AAL2:
```sql
CREATE POLICY "billing_select_aal2" ON public.billing_secrets
FOR SELECT TO authenticated
USING (
  public.is_member(organization_id)
  AND (auth.jwt() ->> 'aal') = 'aal2'
);
```

### Auditar enforcement
```sql
-- Users com MFA enrolled
SELECT u.id, u.email,
  count(f.id) AS factor_count,
  array_agg(f.factor_type) AS types
FROM auth.users u
LEFT JOIN auth.mfa_factors f ON f.user_id = u.id AND f.status = 'verified'
GROUP BY u.id, u.email
ORDER BY factor_count;

-- Admins/owners sem MFA = risco
SELECT u.email, m.role, m.organization_id
FROM public.memberships m
JOIN auth.users u ON u.id = m.user_id
LEFT JOIN auth.mfa_factors f ON f.user_id = u.id AND f.status = 'verified'
WHERE m.role IN ('owner', 'admin')
  AND m.is_active = true
  AND f.id IS NULL;
```

### Anti-patterns MFA
- Enforcement opcional + sem alertas → utilizadores nunca enrollam
- Não bloquear AAL1 em operações de billing / settings / role change
- Aceitar `getUser()` sem verificar `aal` para operações sensíveis

## Anonymous sign-ins

Permite criar sessão sem email/password. Útil para guest mode, trials, carrinho de compras antes de registo.

### Activar
Dashboard → Auth → Sign In / Up → Allow anonymous sign-ins.

### Uso
```ts
const { data, error } = await supabase.auth.signInAnonymously()
// data.user.id é um UUID válido, mas o user não tem email/identidade
// data.user.is_anonymous === true
```

### Detectar em RLS
```sql
-- Bloquear anonymous em tabelas que requerem identidade verificada
CREATE POLICY "documents_authenticated_only" ON public.documents
FOR INSERT TO authenticated
WITH CHECK (
  (auth.jwt() ->> 'is_anonymous')::boolean IS NOT TRUE
  AND public.is_member(organization_id)
);
```

### Conversão para conta permanente
```ts
// User anónimo "linka" um email
const { data, error } = await supabase.auth.updateUser({ email: 'user@example.com' })
// Envia confirmação → ao confirmar, anonymous flag = false
```

### Riscos de anonymous
- **Spam de utilizadores anónimos**: cada visita pode criar um row em `auth.users`. Activar CAPTCHA.
- **Dados órfãos**: anonymous sem conversão acumulam dados. Implementar cleanup periódico:
  ```sql
  -- Apagar anonymous antigos sem atividade
  DELETE FROM auth.users
  WHERE is_anonymous = true
    AND created_at < now() - interval '30 days'
    AND last_sign_in_at < now() - interval '7 days';
  ```
- **Confusão com utilizadores reais**: filtrar `WHERE NOT is_anonymous` em queries de admin / analytics.

### Quando NÃO usar anonymous
- Apps B2B / SaaS pago — exigir registo desde o início
- Operações que requerem auditoria (compliance, financial) — anonymous = sem identidade legal

## SSO / SAML (enterprise)

Disponível em planos Team/Enterprise. Cliente final entra via IdP corporativo (Okta, Azure AD, Google Workspace, etc.).

### Setup (Dashboard)
1. Auth → Providers → SAML → adicionar provider com metadata XML/URL do IdP
2. Configurar SP metadata no IdP (entity ID, ACS URL fornecidos pelo Supabase)
3. Mapear attributes (email, role, groups → claims)

### Por CLI (Management API)
```bash
supabase sso add saml \
  --type saml \
  --metadata-file ./idp-metadata.xml \
  --domains acme.com,acme.eu
```

### Provisioning automático
Quando um user entra via SSO, o Supabase cria automaticamente entry em `auth.users` e `auth.identities`. O `email_domain` deve estar associado ao SSO provider para forçar fluxo.

### Padrão multi-tenant + SSO
Cada org pode ter o seu provider SSO. Mapping `email_domain → organization_id` controla a entrada:

```sql
CREATE TABLE public.org_sso_domains (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  email_domain text NOT NULL,
  sso_provider_id text,
  is_verified boolean NOT NULL DEFAULT false,
  PRIMARY KEY (organization_id, email_domain)
);

-- Após SSO sign-in, auto-membership na org dona do domínio
CREATE OR REPLACE FUNCTION public.handle_sso_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, pg_temp
AS $$
DECLARE
  user_domain text := split_part(NEW.email, '@', 2);
  target_org uuid;
BEGIN
  -- Detetar org pelo domínio
  SELECT organization_id INTO target_org
  FROM public.org_sso_domains
  WHERE email_domain = user_domain AND is_verified = true
  LIMIT 1;

  IF target_org IS NOT NULL THEN
    INSERT INTO public.memberships (organization_id, user_id, role)
    VALUES (target_org, NEW.id, 'member')
    ON CONFLICT (organization_id, user_id) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_sso_user_created
AFTER INSERT ON auth.users
FOR EACH ROW
WHEN (NEW.raw_app_meta_data ->> 'provider' LIKE 'sso:%')
EXECUTE FUNCTION public.handle_sso_user();
```

### Just-In-Time provisioning + role mapping

Mapear groups do IdP para roles internos:
```ts
// Custom Access Token Hook
const groups = event.claims.app_metadata?.sso?.groups ?? []
const role = groups.includes('AcmeAdmins') ? 'admin' : 'member'
```

### Auditar SSO
```sql
-- Quantos users vêm de SSO vs password
SELECT
  CASE
    WHEN raw_app_meta_data ->> 'provider' LIKE 'sso:%' THEN 'sso'
    WHEN raw_app_meta_data ->> 'provider' = 'email' THEN 'email'
    ELSE raw_app_meta_data ->> 'provider'
  END AS provider,
  count(*)
FROM auth.users
GROUP BY 1;

-- Identidades por user (pode ter múltiplas — SSO + password)
SELECT user_id, array_agg(provider) AS providers
FROM auth.identities
GROUP BY user_id
HAVING count(*) > 1;
```

### Anti-patterns SSO
- Manter password auth ativa para emails de domínios cobertos por SSO — permite bypass do IdP
- Auto-membership sem `is_verified = true` no domínio — qualquer um cria `acme.com` no IdP próprio e entra
- Não revogar memberships quando user sai do IdP — implementar SCIM ou job periódico
- JIT provisioning a admins/owners — restringir auto-role a `member`/`viewer`
