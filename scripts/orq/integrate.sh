#!/usr/bin/env bash
# uso: integrate.sh Txx "Título" — commit no worktree, rebase em main, ff-merge, verify em main (SPEC 2.5)
# Modo lote (integrate-batch.sh): ORQ_TARGET=<branch do lote> rebaseia sobre ele em vez da main, e ORQ_NO_VERIFY=1
# para depois da regeração de migration: só avança o branch do lote até a tarefa (sem verify, merge, push nem limpeza).
# Conflitos resolvidos sozinhos: pontos de registro (union.mjs), pnpm-lock (regenera) e migrations crm
# (journal/snapshot de main + regeração com o mesmo nome; para se o SQL regenerado diferir do original).
# Caminhos relativos ao próprio script (scripts/orq/ no checkout da main); temporários em .orq-tmp/ (gitignored).
ROOT=$(cd "$(dirname "$0")/../.." && pwd); SP="$ROOT/.orq-tmp"; mkdir -p "$SP"
# Roda de uma cópia em .orq-tmp: o ff-merge da main pode reescrever este arquivo durante a execução.
if [ "${ORQ_INTEGRATE_COPY:-}" != 1 ]; then cp "$0" "$SP/integrate.run.sh"; ORQ_INTEGRATE_COPY=1 ORQ_DIR="$(cd "$(dirname "$0")" && pwd)" exec bash "$SP/integrate.run.sh" "$@"; fi
ORQ=${ORQ_DIR}; ROOT=$(cd "$ORQ/../.." && pwd); SP="$ROOT/.orq-tmp"
set -uo pipefail
TGT=${ORQ_TARGET:-main}
T=$1; TITLE=$2; WT=$(cd "$ROOT/.." && pwd)/leonas-crm-wt/$T
MIG=packages/db/drizzle/crm
cd "$WT" || exit 1
if git status | grep -q "rebase in progress"; then echo "ABORTADO: rebase em andamento em $T — resolva antes"; exit 4; fi
# spec/SPEC.md, spec/verify/**, STATUS, briefs e docs/licoes.md são do Orquestrador: a tarefa nunca os leva no commit
git checkout main -- spec/SPEC.md spec/verify spec/STATUS.md spec/briefs docs/licoes.md 2>/dev/null || true
git add -A
git diff --cached --quiet || git commit -q -m "$T: $TITLE

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
# um único commit da tarefa sobre a base dela: o rebase vê todas as migrations da tarefa de uma vez
BASE=$(git merge-base HEAD "$TGT")
if [ "$(git rev-list --count "$BASE"..HEAD)" -gt 1 ]; then
  git reset -q --soft "$BASE" && git commit -q -m "$T: $TITLE

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && echo "commits da tarefa unidos em 1"
fi
REGEN=()
if ! git rebase -q "$TGT" >/dev/null 2>&1; then
  while true; do
    C=$(git diff --name-only --diff-filter=U)
    [ -z "$C" ] && break
    if echo "$C" | grep -q "^$MIG/meta/"; then
      # migrations da tarefa: guarda o SQL original e remove (será regenerado depois do rebase)
      for f in $(git diff --name-only --diff-filter=A REBASE_HEAD~1 REBASE_HEAD -- "$MIG/*.sql"); do
        name=$(basename "$f" .sql | sed 's/^[0-9]*_//'); git show "REBASE_HEAD:$f" > "$SP/regen-$T-$name.sql"
        REGEN+=("$name"); git rm -q --cached "$f" 2>/dev/null; rm -f "$f"; echo "migration $name será regenerada"
      done
      for f in $(echo "$C" | grep "^$MIG/meta/"); do git checkout --ours "$f" && git add "$f"; done
      # snapshots que só a tarefa criou também saem (senão o drizzle-kit compara com eles e não gera nada)
      for f in $(git diff --name-only --diff-filter=A REBASE_HEAD~1 REBASE_HEAD -- "$MIG/meta/*_snapshot.json"); do
        git cat-file -e "HEAD:$f" 2>/dev/null || { git rm -q --cached "$f" 2>/dev/null; rm -f "$f"; }
      done
    fi
    # relatórios gerados: sempre os de main (o verify do gate regrava)
    for f in $(echo "$C" | grep "^spec/reports/" || true); do git checkout --ours "$f" && git add "$f"; done
    OTHER=$(echo "$C" | grep -v "^pnpm-lock.yaml$" | grep -v "^$MIG/meta/" | grep -v "^spec/reports/" || true)
    if [ -n "$OTHER" ]; then node "$ORQ/union.mjs" $OTHER || { echo "REBASE CONFLITO manual em $T: $OTHER"; exit 2; }; git add $OTHER; fi
    if echo "$C" | grep -q "^pnpm-lock.yaml$"; then git checkout --ours pnpm-lock.yaml && pnpm install >/dev/null 2>&1 && git add pnpm-lock.yaml && echo "lockfile regenerado"; fi
    GIT_EDITOR=true git rebase --continue >/dev/null 2>&1 && break
    git status | grep -q "rebase in progress" || break
  done
fi
if [ ${#REGEN[@]} -gt 0 ]; then
  pnpm install >/dev/null 2>&1
  # UMA migration regenerada (com o nome da primeira) cobre todas as da tarefa; compara o CONJUNTO de comandos SQL
  name=${REGEN[0]}
  pnpm --filter @crm/db db:generate:crm --name "$name" >/dev/null 2>&1
  N=$(ls $MIG/*_"$name".sql 2>/dev/null | head -1)
  [ -z "$N" ] && { echo "FALHA: regeneração de $name não gerou arquivo"; exit 5; }
  stmts() { cat "$@" | grep -v '^--' | tr -s ' \n' | sed 's/--> statement-breakpoint/\n/g' | sed 's/^ *//; s/ *$//' | grep -v '^$' | sort; }
  ORIG=(); for n in "${REGEN[@]}"; do ORIG+=("$SP/regen-$T-$n.sql"); done
  if diff <(stmts "${ORIG[@]}") <(stmts "$N") >/dev/null; then
    echo "regenerada: $(basename "$N") (mesmos comandos SQL de ${#REGEN[@]} migration(s) original(is))"
  else
    echo "PARE: $(basename "$N") difere do original (SQL manual?) — compare com ${ORIG[*]}"; exit 5
  fi
  git add -A "$MIG" && git commit -q -m "$T: regenera migration sobre main"
fi
# Modo lote: só avança o branch do lote até esta tarefa; o integrate-batch.sh verifica o lote inteiro de uma vez.
if [ "${ORQ_NO_VERIFY:-}" = 1 ]; then
  git merge-base --is-ancestor "$TGT" HEAD || { echo "FALHA: task/$T não descende de $TGT"; exit 7; }
  git -C "$ROOT" branch -f "$TGT" "task/$T" && echo "lote $TGT ← $T"; exit 0
fi
# Gate: o worktree rebaseado é exatamente o próximo main — verificar AQUI, antes do merge.
pnpm install >/dev/null 2>&1
B=$(git rev-parse --short main); FAIL=0
# Suíte completa UMA vez, aqui (--full no operário); a repetição por instabilidade roda só o que falhou (--retry-failed).
for r in operario tester; do
  F=""; [ $r = operario ] && F="--full"
  o=$(node spec/verify/verify.mjs "$T" --role $r --base "$B" $F 2>&1 | grep -E '✘|APROVADO|REPROVADO' | tail -4)
  echo "$o" | grep -q APROVADO || { echo "($r reprovou; repetindo só o que falhou)"; o=$(node spec/verify/verify.mjs "$T" --role $r --base "$B" $F --retry-failed 2>&1 | grep -E '✘|APROVADO|REPROVADO' | tail -4); }
  echo "$o"; echo "$o" | grep -q APROVADO || FAIL=1
done
[ $FAIL = 1 ] && { echo "PARE: verify reprovado sobre main — NÃO integrado"; exit 6; }
git add spec/reports && git commit -qm "reports: $T" >/dev/null 2>&1 || true
cd "$ROOT" && git merge -q --ff-only "task/$T" || exit 3
# envia a main ao GitHub (só a main; nunca task/* nem .orq-tmp); falha de rede/credencial não bloqueia o gate
timeout 120 git push -q origin main >"$SP/push.log" 2>&1 && echo "push origin main ok" || echo "aviso: git push origin main falhou (ver .orq-tmp/push.log)"
pnpm install --frozen-lockfile >/dev/null 2>&1 || pnpm install >/dev/null 2>&1
git log --oneline -1
# limpeza do worktree (caminhos longos do pnpm no Windows)
git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1 || true
git -C "$ROOT" worktree prune
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$ORQ/rm-worktree.ps1")" -Task "$T" >/dev/null 2>&1 || echo "aviso: limpe $WT manualmente"
echo "worktree $T removido"
