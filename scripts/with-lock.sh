#!/usr/bin/env bash
#
# One heavy check at a time, per workspace.
#
# Several agent sections share this checkout and this machine. Each one decides
# on its own to run `pnpm typecheck`, and none of them can see the others doing
# the same — so on an 8 GB box two or three concurrent `tsc` sweeps push the
# machine into swap and everything, including the app the agents are editing,
# crawls. Telling agents "don't do that" cannot work: they are not wrong about
# their own turn, only about the machine.
#
# This serialises instead. The second caller waits for the first rather than
# competing with it, and total wall-clock time goes DOWN, because two typechecks
# racing through swap are slower than the same two run back to back.
#
# Usage:
#   scripts/with-lock.sh pnpm typecheck        # run, waiting your turn
#   scripts/with-lock.sh --status              # who holds it + machine headline
#
# It never hard-blocks work: past PANDA_LOCK_TIMEOUT it warns and runs anyway.

set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
lock_dir="$repo_root/.git/panda-heavy.lock"
meta_file="$lock_dir/holder"

# Waited-out rather than failed: a stuck holder should slow a section down, not
# strand it. Fifteen minutes is longer than any check in this repo.
timeout="${PANDA_LOCK_TIMEOUT:-900}"
label="${PANDA_LOCK_LABEL:-${PANDA_CODE_SECTION:-$(basename "${PWD}")}}"

human_age() {
  local seconds="$1"
  if [ "$seconds" -lt 60 ]; then
    printf '%ss' "$seconds"
  else
    printf '%sm%ss' "$((seconds / 60))" "$((seconds % 60))"
  fi
}

# The holder's pid, or empty if the lock is free or its metadata is unreadable.
holder_pid() {
  [ -f "$meta_file" ] || return 0
  sed -n '1p' "$meta_file" 2>/dev/null
}

holder_line() {
  [ -f "$meta_file" ] || return 0
  local pid started who cmd age
  pid="$(sed -n '1p' "$meta_file" 2>/dev/null)"
  started="$(sed -n '2p' "$meta_file" 2>/dev/null)"
  who="$(sed -n '3p' "$meta_file" 2>/dev/null)"
  cmd="$(sed -n '4p' "$meta_file" 2>/dev/null)"
  age=$(( $(date +%s) - ${started:-0} ))
  printf '%s (pid %s, from %s, running %s)' "${cmd:-?}" "${pid:-?}" "${who:-?}" "$(human_age "$age")"
}

machine_headline() {
  local load mem_free swap top
  load="$(sysctl -n vm.loadavg 2>/dev/null | tr -d '{}' | awk '{printf "%s %s %s", $1, $2, $3}')"
  swap="$(sysctl -n vm.swapusage 2>/dev/null | awk '{print $6}')"
  # Free + inactive pages against the total, which is the number that predicts
  # whether the next big process swaps. `memory_pressure` needs no privileges.
  mem_free="$(memory_pressure 2>/dev/null | awk -F': ' '/percentage/ {print $2; exit}')"
  echo "load (1m 5m 15m): ${load:-?}   free memory: ${mem_free:-?}   swap used: ${swap:-?}"
  echo
  echo "heaviest processes:"
  # shellcheck disable=SC2009
  top="$(ps -Ao pid,%cpu,rss,comm -r 2>/dev/null | head -7)"
  echo "$top" | awk 'NR==1 {printf "  %-8s %-6s %-9s %s\n", "PID", "CPU%", "RSS", "COMMAND"; next}
    {rss=$3/1024; cmd=$4; n=split(cmd, parts, "/"); printf "  %-8s %-6s %-9s %s\n", $1, $2, sprintf("%dMB", rss), parts[n]}'
}

if [ "${1:-}" = "--status" ]; then
  if [ -d "$lock_dir" ] && [ -n "$(holder_pid)" ]; then
    echo "heavy-check lock: HELD by $(holder_line)"
    echo "  a second heavy check would contend with it — prefer a scoped check, or wait."
  else
    echo "heavy-check lock: free"
  fi
  echo
  machine_headline
  exit 0
fi

if [ "$#" -eq 0 ]; then
  echo "usage: scripts/with-lock.sh <command...>   |   scripts/with-lock.sh --status" >&2
  exit 2
fi

# Re-entrancy, the structural test: is the lock held by a process this one is a
# descendant of? Then the work is already inside the outer lock and waiting for
# it would be waiting for ourselves.
#
# The env var below is the fast path, but it cannot be the only one: `turbo run`
# executes its tasks in a FILTERED environment, so `PANDA_LOCK_HELD` set by the
# root script never reaches the per-package script. That deadlocked the first
# version of this file — `pnpm typecheck` sat for eleven minutes waiting on its
# own parent. Walking the ppid chain does not care what turbo passes through.
held_by_ancestor() {
  local holder walker guard
  holder="$(holder_pid)"
  [ -n "$holder" ] || return 1

  walker="$$"
  # Bounded: a corrupt ppid chain must not spin.
  for guard in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16; do
    walker="$(ps -o ppid= -p "$walker" 2>/dev/null | tr -d ' ')"
    [ -n "$walker" ] && [ "$walker" != "0" ] && [ "$walker" != "1" ] || return 1
    [ "$walker" = "$holder" ] && return 0
  done
  return 1
}

if [ "${PANDA_LOCK_HELD:-}" = "1" ]; then
  exec "$@"
fi

command_text="$*"
waited=0
announced=0

while ! mkdir "$lock_dir" 2>/dev/null; do
  if held_by_ancestor; then
    # Nothing to release here: the ancestor's trap owns the lock.
    exec "$@"
  fi

  pid="$(holder_pid)"

  # A holder that died mid-run (crash, restart, SIGKILL) leaves the directory
  # behind. Nothing else can clear it, so a live-pid check does.
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    echo "[lock] clearing a stale lock (holder pid ${pid:-unknown} is gone)" >&2
    rm -rf "$lock_dir"
    continue
  fi

  if [ "$announced" -eq 0 ]; then
    echo "[lock] waiting: $(holder_line)" >&2
    echo "[lock] queued here: $command_text" >&2
    announced=1
  elif [ $((waited % 30)) -eq 0 ]; then
    echo "[lock] still waiting ($(human_age "$waited") so far)" >&2
  fi

  if [ "$waited" -ge "$timeout" ]; then
    echo "[lock] waited $(human_age "$waited"); running anyway — the machine may thrash." >&2
    break
  fi

  sleep 3
  waited=$((waited + 3))
done

cleanup() {
  rm -rf "$lock_dir"
}
trap cleanup EXIT INT TERM

printf '%s\n%s\n%s\n%s\n' "$$" "$(date +%s)" "$label" "$command_text" >"$meta_file" 2>/dev/null

if [ "$announced" -eq 1 ]; then
  echo "[lock] acquired after $(human_age "$waited"); starting: $command_text" >&2
fi

PANDA_LOCK_HELD=1 "$@"
status=$?
exit "$status"
