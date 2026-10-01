#!/usr/bin/env bash
# Installs jev-browser's Claude Code setup for the current user:
#   ~/.local/bin        jev-browser, jev-browser-mcp, jev, jev-router
#   ~/.claude/skills    jev-browser and use-jev (symlinks into this repo)
#   ~/.pi/agent/skills  the same two skills, when the pi coding agent is installed
#   ~/.claude/agents    jev-tiny, jev-everyday, jev-large, jev-hardest
#   ~/.config/jev       builtin-skills.json, and openrouter.env (key placeholder, mode 600)
#   ~/.claude/settings.json   the jev-router UserPromptSubmit hook
# Safe to re-run. It never prints or overwrites an existing API key, and it
# backs up settings.json before changing it. Build the package first:
#   npm ci && npm run build
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
setup_dir="$repo_dir/agent-setup"
bin_dir="$HOME/.local/bin"
skills_dir="$HOME/.claude/skills"
agents_dir="$HOME/.claude/agents"
config_dir="$HOME/.config/jev"
settings_file="$HOME/.claude/settings.json"

for command in node python3 jq curl; do
    if ! command -v "$command" >/dev/null; then
        echo "missing required command: $command" >&2
        exit 1
    fi
done
if [[ ! -f "$repo_dir/dist/index.js" ]]; then
    echo "dist/index.js is missing; run 'npm ci && npm run build' in $repo_dir first" >&2
    exit 1
fi

mkdir -p "$bin_dir" "$skills_dir" "$agents_dir" "$config_dir"

# Commands. The two wrappers carry this clone's path.
install -m 755 "$setup_dir/bin/jev" "$setup_dir/bin/jev-router" "$bin_dir/"
for wrapper in jev-browser jev-browser-mcp; do
    sed "s|__JEV_BROWSER_DIR__|$repo_dir|" "$setup_dir/bin/$wrapper" > "$bin_dir/$wrapper"
    chmod 755 "$bin_dir/$wrapper"
done
echo "installed commands in $bin_dir"

# Skills are linked, so pulling this repo updates them. A real directory of
# the same name belongs to someone else and is left alone.
link_skill() {
    local source_dir="$1" name="$2" into_dir="${3:-$skills_dir}"
    local target="$into_dir/$name"
    if [[ -e "$target" && ! -L "$target" ]]; then
        echo "skipped skill $name: $target exists and is not a symlink"
        return
    fi
    ln -sfn "$source_dir" "$target"
    echo "linked skill $name"
}
link_skill "$repo_dir/skills/jev-browser" jev-browser
link_skill "$setup_dir/skills/use-jev" use-jev

# pi reads the same SKILL.md format from ~/.pi/agent/skills, and its bash runs
# jev-browser and jev from ~/.local/bin. The router hook and the helper agents
# are Claude Code features, so pi gets the skills only.
pi_skills_dir="$HOME/.pi/agent/skills"
if [[ -d "$HOME/.pi/agent" ]]; then
    mkdir -p "$pi_skills_dir"
    link_skill "$repo_dir/skills/jev-browser" jev-browser "$pi_skills_dir"
    link_skill "$setup_dir/skills/use-jev" use-jev "$pi_skills_dir"
fi

install -m 644 "$setup_dir"/agents/jev-*.md "$agents_dir/"
echo "installed agents jev-tiny, jev-everyday, jev-large, jev-hardest"

if [[ ! -f "$config_dir/builtin-skills.json" ]]; then
    install -m 644 "$setup_dir/config/builtin-skills.json" "$config_dir/"
fi

key_file="$config_dir/openrouter.env"
if [[ ! -f "$key_file" ]]; then
    umask 077
    printf 'OPENROUTER_API_KEY=\n' > "$key_file"
    chmod 600 "$key_file"
    echo "created $key_file: put your OpenRouter key after OPENROUTER_API_KEY="
fi

# The router hook runs on every prompt but does nothing until switched on per
# session with `jev-router on`; any failure passes the prompt through untouched.
hook_command="$bin_dir/jev-router hook 2>/dev/null || true"
[[ -f "$settings_file" ]] || echo '{}' > "$settings_file"
if jq -e --arg command "$hook_command" \
    '[.hooks.UserPromptSubmit[]?.hooks[]?.command] | index($command)' "$settings_file" >/dev/null; then
    echo "jev-router hook already present"
else
    cp "$settings_file" "$settings_file.bak-$(date +%Y%m%d%H%M%S)"
    updated="$(jq --arg command "$hook_command" \
        '.hooks.UserPromptSubmit += [{"hooks": [{"type": "command", "command": $command, "timeout": 4}]}]' "$settings_file")"
    printf '%s\n' "$updated" > "$settings_file"
    echo "added the jev-router hook to $settings_file (backup saved next to it)"
fi

echo "done. Next: put the key in $key_file if it is empty, then try:"
echo "  jev-browser run \"Open the Learn more link\" https://example.com --no-screenshot"
