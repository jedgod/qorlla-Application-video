#!/usr/bin/env python3
"""Apply the reviewed Ollama adapter wiring to a local Qorlla checkout.
Dry-run by default; --apply changes two existing files and copies the new module/test.
Never commits, pushes, migrates, or deploys.
"""
import argparse, pathlib, shutil, sys
ROOT = pathlib.Path(__file__).resolve().parent
p = argparse.ArgumentParser()
p.add_argument('repo', help='Path to repository root (contains qorlla-portal/)')
p.add_argument('--apply', action='store_true')
a = p.parse_args()
repo = pathlib.Path(a.repo).resolve()
base = repo / 'qorlla-portal/server/ai'
providers = base / 'providers.mjs'
config = base / 'config.mjs'
if not providers.is_file() or not config.is_file(): sys.exit('ERROR: Qorlla Portal files not found; no changes made')
old_p, old_c = providers.read_text(), config.read_text()
anchor_p = "import { LlmError } from './llm.mjs';"
anchor_build = "const a = p.id === 'test' ? testAdapter(testDelayMs) : p.id === 'gemini' ? gemini(p, io) : p.id === 'anthropic' ? anthropic(p, io) : chatCompletions(p.id, p, io);"
anchor_c = "if (trim(env.QORLLA_AI_SELFHOSTED_URL)) p.selfhosted = { apiKey: trim(env.QORLLA_AI_SELFHOSTED_API_KEY), baseUrl: trim(env.QORLLA_AI_SELFHOSTED_URL), model: trim(env.QORLLA_AI_SELFHOSTED_MODEL), tier: 'local', external: false };"
for name, content, anchor in [('providers import',old_p,anchor_p),('providers dispatch',old_p,anchor_build),('selfhosted config',old_c,anchor_c)]:
    if content.count(anchor) != 1: sys.exit('ERROR: source mismatch for '+name+'; no changes made')
if (base/'ollama.mjs').exists(): sys.exit('ERROR: existing ollama.mjs; no changes made')
new_p = old_p.replace(anchor_p,anchor_p+"\nimport { createOllamaAdapter } from './ollama.mjs';")
new_p = new_p.replace(anchor_build,"const a = p.id === 'selfhosted' && p.ollama ? createOllamaAdapter({ ...p, allowedHosts: p.allowedHosts, fetchImpl, timeoutMs, concurrency: p.concurrency, maxQueue: p.maxQueue }) : "+anchor_build[len('const a = '):])
new_c = old_c.replace(anchor_c,anchor_c+"\n  if (p.selfhosted && bool(env.QORLLA_AI_SELFHOSTED_OLLAMA)) {\n    p.selfhosted.ollama = true;\n    p.selfhosted.allowedHosts = (trim(env.QORLLA_AI_OLLAMA_ALLOWED_HOSTS) || 'ollama,localhost,127.0.0.1').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);\n    p.selfhosted.concurrency = Number(env.QORLLA_AI_OLLAMA_CONCURRENCY || 2);\n    p.selfhosted.maxQueue = Number(env.QORLLA_AI_OLLAMA_MAX_QUEUE || 8);\n    if (!p.selfhosted.model) problems.push('QORLLA_AI_SELFHOSTED_MODEL is required for Ollama');\n  }")
print('Validated existing anchors. Planned: update providers.mjs, config.mjs; add ollama.mjs and ollama.integration.test.mjs.')
if not a.apply:
    print('DRY RUN: no changes. Pass --apply to write files.'); sys.exit(0)
# All validations happen before any writes. Never touch unrelated files.
for target in [repo/'qorlla-portal/tests/ollama.integration.test.mjs']:
    if target.exists(): sys.exit('ERROR: test file exists; no changes made')
providers.write_text(new_p)
config.write_text(new_c)
shutil.copyfile(ROOT/'qorlla-portal/server/ai/ollama.mjs',base/'ollama.mjs')
shutil.copyfile(ROOT/'qorlla-portal/tests/ollama.integration.test.mjs',repo/'qorlla-portal/tests/ollama.integration.test.mjs')
print('Applied. Run git diff and tests before any commit; do not deploy without authorization.')
