#!/bin/sh
# One command, one honest tally. Runs every status/test-*.mjs; each suite prints its own
# "N passed, M failed" line and exits non-zero on failure. The glob below is asserted from
# inside test-status.mjs — a test the harness never runs is worse than no test.
fail=0
for f in status/test-*.mjs; do
  [ -e "$f" ] || continue
  node "$f" || fail=1
done
exit $fail
