---
name: use-jev
description: Use when the user says "use Jev to sort/decide/classify/score these" about any pile of text. Jev (typesafe/jev-1.13 via OpenRouter) answers typed questions about text almost instantly and very cheaply. It decides; it never writes.
---

# Using Jev

Jev is a fast "System One" model. Send it text (`state`) plus typed `questions`; it returns structured answers. It does not generate prose. Docs: https://docs.typesafe.ai/llms.txt

## Rules
- Jev decides, Claude writes. When Jev is unsure (see confidence below), make the call yourself.
- Anything sent to Jev leaves the machine. Ask the user before sending private text.
- The API key lives in `~/.config/jev/openrouter.env` (mode 600). Never print it, never copy it into a file that could be shared, never commit it.

## Calling it
Write a request JSON and run `jev request.json` (helper at `~/.local/bin/jev`; adds the model and key, prints the response then `elapsed_seconds:`).

- Endpoint: `POST https://openrouter.ai/api/alpha/decisions` (the docs page lists a `/api/v1/api/alpha/...` path that returns 404; the path above is the working one as of 2026-09-30). Model: `typesafe/jev-1.13`.
- Body: `{"state": <text|object|array>, "questions": {<name>: <question>, ...}}`. Many questions per call are cheap because they run in parallel.

## The three question shapes
- `choice`: `{"type":"choice","instructions":"...","criteria":{"option":"description",...}}` (up to 255 options; add an `other` option). Returns `choice`, `probabilities`, `confidence` (0-1).
- `score`: `{"type":"score","instructions":"...","criteria":["lowest level", ..., "highest level"]}` (2-10 ordered levels). Returns `score` (probability-weighted level number), `legend`, `probabilities`, `confidence`.
- `noul` (yes/no): `{"type":"noul","instructions":"...","criteria":{"true":"...","false":"..."}}` (criteria optional). Returns `noul`, the probability of yes. There is no separate confidence: values near 0.5 mean unsure.

## Acting on answers
- Treat `confidence` below about 0.6, or a `noul` between about 0.35 and 0.65, as "Jev is not sure": decide yourself.
- Response also has `usage.cost` (USD) so cost can be reported.
- On failure show the exact error body to the user.

## Privacy filter
Every call sends `"provider": {"data_collection": "deny", "zdr": true}` so OpenRouter refuses rather than route to a provider that trains on or keeps prompts. It adds no measurable latency.

## Model router and skill picker (`jev-router`)
A `UserPromptSubmit` hook in `~/.claude/settings.json` runs `~/.local/bin/jev-router hook`. It is OFF per session until turned on, and silent on any failure or when Jev takes over 1.5 s.
- `jev-router on|off [models|skills|all]` for the current session (uses `$CLAUDE_CODE_SESSION_ID`); `jev-router status`; `jev-router try "text"`; `jev-router skills`.
- Sizes route to agents `jev-tiny` (haiku), `jev-everyday` (sonnet), `jev-large` and `jev-hardest` (opus). Fable is never a routing target. Under 0.6 confidence or a follow-up reply → main session.
- Skill hint loads the picked skill when Jev is at least 0.6 sure. Misses are fixed by clearer descriptions: the user's own skills, `~/.config/jev/builtin-skills.json` for bundled ones, or the `none_of_these` wording in the script.
- The log (`~/.local/state/jev-router/log.jsonl`) stores decisions and cost, never prompt text.

## Verified example (2026-09-30)
A made-up sales email with `lead_strength` (score, 4 levels), `email_kind` (choice) and `needs_personal_reply` (noul) returned in about 0.5 s for about $0.000024.
