#!/usr/bin/env bash
set -euo pipefail

vault_path="${OBSIDIAN_VAULT_PATH:-$HOME/Documents/Knowledge}"
query="${1:-}"
result_limit="${2:-80}"

if [[ -z "$query" ]]; then
  echo "usage: search-vault.sh <rg-pattern> [result-limit]" >&2
  exit 2
fi

if [[ ! -d "$vault_path" ]]; then
  echo "Obsidian vault not found: $vault_path" >&2
  exit 1
fi

if ! [[ "$result_limit" =~ ^[1-9][0-9]*$ ]]; then
  echo "result-limit must be a positive integer" >&2
  exit 2
fi

matches="$(rg -n -i --glob '*.md' --max-count 20 -- "$query" "$vault_path" || true)"

if [[ -z "$matches" ]]; then
  echo "No matches for: $query"
  exit 0
fi

printf '%s\n' "$matches" | sed -n "1,${result_limit}p"
