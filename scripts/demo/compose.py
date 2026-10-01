# Composes the README demo from the four recorded runs in the current directory (see record.sh).
import json, subprocess, textwrap
clips = [
    ("shadow", "Shadow DOM + modal dialogs", "Shoelace's buttons live in shadow roots; a promo modal blocks the page first."),
    ("combobox", "Arrow keys in a combobox", "An ARIA autocomplete: type, press Down, pick the option."),
    ("iframe", "Iframes", "The form sits inside the editor's result iframe."),
    ("listbox", "ARIA options", "Options are plain <li role=option> elements."),
]
font = "/usr/share/fonts/TTF/DejaVuSans.ttf"
bold = "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf"
parts = []
for name, feature, note in clips:
    r = json.load(open(f"{name}.json"))
    lines = []
    for s in r["steps"]:
        if s["executed_action"] is None:
            lines.append(f"{s['step']}. done")
            continue
        detail = s["detail"].replace(" via openrouter", "").replace(" (submit the form now)", "")
        action = s["executed_action"].split("_e")[0]
        lines += textwrap.wrap(f"{s['step']}. {action}: {detail}", 40, subsequent_indent="   ")
    result = f"{r['status']} in {r['elapsed_ms']/1000:.1f} s, {r['usage']['jev_calls']} Jev calls, ${r['usage']['est_cost_usd']:.4f}"
    body = "\n".join(textwrap.wrap(note, 40)) + "\n\nSteps Jev chose:\n" + "\n".join(lines) + "\n\nResult:\n" + result
    open(f"{name}.txt", "w").write(body.replace("%", "%%"))
    out = f"{name}.mp4"
    vf = (f"tpad=stop_mode=clone:stop_duration=2.5,pad=1200:500:0:0:color=0x111318,"
          f"drawtext=fontfile={bold}:text='{feature}':x=820:y=24:fontsize=21:fontcolor=0xF2C14E,"
          f"drawtext=fontfile={font}:textfile={name}.txt:x=820:y=64:fontsize=15:line_spacing=6:fontcolor=0xE8E8E8,"
          f"fps=12,format=yuv420p")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", f"{name}.webm", "-vf", vf, "-an", "-c:v", "libx264", "-crf", "26", out], check=True)
    parts.append(out)
open("list.txt", "w").write("".join(f"file '{p}'\n" for p in parts))
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "jev-browser-demo.mp4"], check=True)
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", "jev-browser-demo.mp4", "-vf",
    "fps=8,scale=1000:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4",
    "jev-browser-demo.gif"], check=True)
