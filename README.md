# motonuvem-mirror-worker

Worker rodando em **GitHub Actions** que baixa um arquivo de uma URL pública (Google Drive público, link HTTP direto, etc.) e re-hospeda no **Pixeldrain**. Usado pelo projeto Moto Nuvem pra contornar o timeout de ~400s das Edge Functions em arquivos grandes (>800 MB).

Este repositório é **público de propósito**: GitHub Actions só dá minutos ilimitados em repos públicos. Não há segredos nem regra de negócio no código — só dois secrets de runtime configurados em **Settings → Secrets and variables → Actions**.

## Como funciona

1. A Edge Function `pixeldrain-mirror` no Lovable detecta um arquivo grande.
2. Dispara este workflow via `workflow_dispatch` (preferencial) ou `repository_dispatch`, com `mirror_id`, `source_url`, `file_name`, `file_size` e `callback_url`.
3. O job baixa o arquivo pra `/tmp` do runner, sobe pro Pixeldrain (`PUT /api/file/{name}`) e chama de volta a edge function `pixeldrain-mirror-callback` reportando o `pixeldrain_file_id`.

## Setup (uma vez)

Em **Settings → Secrets and variables → Actions → New repository secret**, crie:

| Nome | Valor |
|------|-------|
| `PIXELDRAIN_API_KEY` | Mesma chave da sua conta Pixeldrain (a que já está no Lovable). |
| `CALLBACK_TOKEN`     | Mesmo valor de `MIRROR_WORKER_CALLBACK_TOKEN` no Lovable. |

Pronto. Os arquivos `mirror.yml` e `scripts/mirror.mjs` já estão prontos pra rodar. Esta versão v4 baixa links `pixeldrain.com`, `pixeldrain.dev`, `/u/`, `/d/` e `/api/file` pela API, além de tratar o aviso do Google Drive com `drive.usercontent`/`resourcekey` sem salvar HTML como arquivo.

## Teste manual

Use a aba **Actions → mirror → Run workflow** e passe um `mirror_id` real (uuid existente em `rom_mirrors` no Lovable, com status `dispatched`), uma `source_url` pequena (ex: 50 MB), `file_name` qualquer e a `callback_url`:

```
https://<seu-project-ref>.supabase.co/functions/v1/pixeldrain-mirror-callback
```

## Limites

- Timeout do job: 350 min (limite total do GitHub é 360).
- Disco do runner: ~14 GB livres em `/tmp` (ROMs até ~10 GB cabem sem problema).
- Paralelismo padrão: até 20 jobs simultâneos por repo no plano free.
