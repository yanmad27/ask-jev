#!/usr/bin/env bash
exec claude plugin eval "$(dirname "$0")/.." --ablation none --allow-tools Bash Write --judge-model sonnet "$@"
