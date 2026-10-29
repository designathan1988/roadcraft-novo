#!/usr/bin/env bash
# Runs each test file with a limit so one hung test cannot hide the others. Reads only; no git.
set -u
mkdir -p test-results
out=test-results/test-sweep.log
: > "$out"
for f in test/*.test.ts; do
  echo "===== $f =====" | tee -a "$out"
  timeout 20s node --test "$f" >>"$out" 2>&1
  code=$?
  echo "exit=$code" | tee -a "$out"
done
echo "sweep done" | tee -a "$out"
