#!/usr/bin/env bash
# uso: integrate-batch.sh T1 T2 [T3 ...] — gate em LOTE de tarefas aprovadas (operário e tester DONE).
#  1. branch temporário batch/<ts> a partir da main;
#  2. cada tarefa, em sequência: commit + rebase sobre o lote + regeração de migration (integrate.sh em modo lote);
#     tarefa com conflito manual sai do lote (volta para a main) e é avisada;
#  3. no worktree da última tarefa (= ponta do lote): verify.mjs batch — união dos comandos com a suíte completa UMA vez,
#     dependentes e os testes de aceitação de cada tarefa (repete 1x só o que falhou);
#  4. verde: ff da main até o lote, push, limpeza dos worktrees. Vermelho: cada tarefa volta para a main e passa pelo
#     gate individual (integrate.sh), em ordem — as boas entram, a culpada fica reprovada para voltar ao operário.
# Com uma tarefa só, delega ao integrate.sh.
ROOT=$(cd "$(dirname "$0")/../.." && pwd); SP="$ROOT/.orq-tmp"; mkdir -p "$SP"
if [ "${ORQ_BATCH_COPY:-}" != 1 ]; then cp "$0" "$SP/integrate-batch.run.sh"; ORQ_BATCH_COPY=1 ORQ_DIR="$(cd "$(dirname "$0")" && pwd)" exec bash "$SP/integrate-batch.run.sh" "$@"; fi
ORQ=${ORQ_DIR}; ROOT=$(cd "$ORQ/../.." && pwd); SP="$ROOT/.orq-tmp"; WTROOT=$(cd "$ROOT/.." && pwd)/leonas-crm-wt
set -uo pipefail
[ $# -ge 1 ] || { echo "uso: integrate-batch.sh T1 T2 ..."; exit 2; }
title() { node -e "import('file:///$(cygpath -m "$ROOT")/spec/verify/tasks.mjs').then((m) => console.log(m.TASKS.find((t) => t.id === '$1')?.title ?? '$1'))"; }
if [ $# -eq 1 ]; then exec bash "$ORQ/integrate.sh" "$1" "$(title "$1")"; fi

BATCH="batch/$(date +%s)"
git -C "$ROOT" branch "$BATCH" main || exit 2
OK=()
for T in "$@"; do
  git -C "$ROOT" rev-parse "$BATCH" > "$SP/batch-prev-$T"
  if ORQ_TARGET="$BATCH" ORQ_NO_VERIFY=1 bash "$ORQ/integrate.sh" "$T" "$(title "$T")"; then
    OK+=("$T")
  else
    echo "AVISO: $T fora do lote (conflito na montagem); gate individual depois"
    git -C "$WTROOT/$T" rebase --abort >/dev/null 2>&1 || true
  fi
done
[ ${#OK[@]} -gt 0 ] || { git -C "$ROOT" branch -D "$BATCH" >/dev/null 2>&1; echo "PARE: nenhuma tarefa montou no lote"; exit 2; }
LAST=${OK[${#OK[@]}-1]}; IDS=$(IFS=,; echo "${OK[*]}")
echo "lote $BATCH: ${OK[*]} (verificando no worktree $LAST)"
cd "$WTROOT/$LAST" || exit 1
pnpm install >/dev/null 2>&1
B=$(git rev-parse --short main)
o=$(node spec/verify/verify.mjs batch "$IDS" --base "$B" 2>&1 | tee "$SP/batch-$(date +%s).log" | grep -E '✘|APROVADO|REPROVADO' | tail -10)
echo "$o" | grep -q APROVADO || { echo "(lote reprovou; repetindo só o que falhou)"; o=$(node spec/verify/verify.mjs batch "$IDS" --base "$B" --retry-failed 2>&1 | grep -E '✘|APROVADO|REPROVADO' | tail -10); }
echo "$o"
if echo "$o" | grep -q APROVADO; then
  git add spec/reports && git commit -qm "reports: lote $IDS" >/dev/null 2>&1 || true
  cd "$ROOT" && git merge -q --ff-only "task/$LAST" || { echo "PARE: ff da main falhou"; exit 3; }
  timeout 120 git push -q origin main >"$SP/push.log" 2>&1 && echo "push origin main ok" || echo "aviso: git push origin main falhou (ver .orq-tmp/push.log)"
  pnpm install --frozen-lockfile >/dev/null 2>&1 || pnpm install >/dev/null 2>&1
  git log --oneline -1
  for T in "${OK[@]}"; do
    git -C "$ROOT" worktree remove --force "$WTROOT/$T" >/dev/null 2>&1 || true
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$ORQ/rm-worktree.ps1")" -Task "$T" >/dev/null 2>&1 || true
  done
  git -C "$ROOT" worktree prune; git -C "$ROOT" branch -D "$BATCH" >/dev/null 2>&1
  echo "LOTE INTEGRADO: ${OK[*]}"
  # tarefas que ficaram fora do lote seguem pelo gate individual
  for T in "$@"; do case " ${OK[*]} " in *" $T "*) ;; *) bash "$ORQ/integrate.sh" "$T" "$(title "$T")" ;; esac; done
  exit 0
fi
# Vermelho: desmonta o lote (cada tarefa volta a ficar sozinha sobre a main) e passa uma a uma pelo gate normal.
echo "LOTE REPROVADO: isolando a culpada com gates individuais"
for T in "${OK[@]}"; do
  ( cd "$WTROOT/$T" && git rebase -q --onto main "$(cat "$SP/batch-prev-$T")" "task/$T" >/dev/null 2>&1 ) || { git -C "$WTROOT/$T" rebase --abort >/dev/null 2>&1; echo "AVISO: $T não voltou sozinho para a main (o gate individual rebaseia de novo)"; }
done
git -C "$ROOT" branch -D "$BATCH" >/dev/null 2>&1
for T in "$@"; do bash "$ORQ/integrate.sh" "$T" "$(title "$T")" || echo "REPROVADA: $T (volta para o operário)"; done
