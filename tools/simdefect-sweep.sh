#!/usr/bin/env bash
set -u
mkdir -p test-results
out=test-results/simdefect-sweep.log
: > "$out"
names=(C8 C12 C9 C11 C6 C1 C4 C5 C15 C16 C17 C2 C3 C20 C27 C21 C48 C50 C22 C19 C18 C10 C31 C32 C42 C34 C35 C37 C38 C40 C45 C25 C28 C24 C26 C51 C52 C43 C23 C33)
for name in "${names[@]}"; do
  echo "===== $name =====" | tee -a "$out"
  timeout 15s node --test --test-name-pattern="^${name}:" test/simDefects.test.ts >>"$out" 2>&1
  echo "exit=$?" | tee -a "$out"
done
echo "sweep done" | tee -a "$out"
