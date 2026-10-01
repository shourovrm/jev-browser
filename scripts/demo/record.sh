#!/usr/bin/env bash
# Records the README demo: four live jev-browser runs, one per feature this
# fork added, composed with a side panel of Jev's steps into
# assets/jev-browser-demo.{gif,mp4}. Needs the jev-browser CLI on PATH (with
# its key), ffmpeg and python3. Runs spend a few tenths of a cent in Jev calls.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
cd "$work_dir"

record() {
    local name="$1" task="$2" url="$3"
    jev-browser run "$task" "$url" --record "$work_dir/$name.webm" --no-screenshot --max-steps 8 --max-chars 200 > "$name.json"
}
record shadow "Open the first example dialog on this page so that it is showing" "https://shoelace.style/components/dialog"
record combobox "In the State combobox, type Ne and pick Nevada from the suggestion list" "https://www.w3.org/WAI/ARIA/apg/patterns/combobox/examples/combobox-autocomplete-list/"
record iframe "In the example form shown in the result pane, submit the form" "https://www.w3schools.com/html/tryit.asp?filename=tryhtml_form_submit"
record listbox "In the scrollable listbox of transuranium elements, select Neptunium" "https://www.w3.org/WAI/ARIA/apg/patterns/listbox/examples/listbox-scrollable/"

python3 "$repo_dir/scripts/demo/compose.py"
cp jev-browser-demo.gif jev-browser-demo.mp4 "$repo_dir/assets/"
echo "wrote $repo_dir/assets/jev-browser-demo.gif and .mp4; check each run's status in the panel before committing"
