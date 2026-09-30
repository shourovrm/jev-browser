# Roadmap

This local fork (based on upstream 0.8.1) plans three features: shadow DOM, iframes, and keyboard navigation inside menus. None is built yet. Each section states what happens today, the change, the tests to write first, and the live check that closes it. Build them in the order given under [Build order](#build-order).

## Shadow DOM

jev-browser offers Jev no control that lives inside a web component. The element scan in `extractAndStamp` (`src/navigate.ts`) runs `document.querySelectorAll(SEL)`, and that query does not enter shadow roots, so a button inside `<my-widget>` never reaches the action list.

Clicking needs no change. Playwright's CSS selectors pierce open shadow roots, so `selectorFor()` (`[data-jev-id="jN"]`) already finds a stamped element inside one.

**Change**
- Add a helper that collects candidates from `document` and then recursively from every `element.shadowRoot`. Open roots only: the browser gives scripts no access to closed roots.
- Use that helper wherever the code scans the page: the stamp-clearing pass at the top of `extractAndStamp`, the scan itself, and the counts in `settle()`, `waitForFirstContent()` and `menuSnapshot()`. If the counts stay light-DOM only, a page that renders inside a component looks empty and never "settles".

**Tests to write first**
- A custom element with an open shadow root holding a button and a link. Both are offered and the button is clickable.
- A shadow root nested inside another shadow root. The inner control is offered.
- A closed shadow root. Its control is not offered, and the run does not error.

**Live check:** a public page built from web components, such as the Shoelace component documentation, reaches a control inside a component.

## Iframes

jev-browser reads and acts on the main frame only. Every `page.evaluate` and `page.click` call targets the main frame, so controls inside an iframe are never offered: embedded search boxes, embedded forms, cookie-consent dialogs, and payment or map widgets.

Playwright can reach cross-origin frames too, through `page.frames()` and `frame.evaluate()`, so the gap is in jev-browser, not the browser.

**Change**
- Run the element scan in each frame, main frame first, sharing the one `MAX_ELEMENTS` budget.
- Skip frames that are unrelated to the task: hidden or zero-size frames, `about:blank`, and frames under 50×50 px, which are mostly tracking pixels and ads.
- Prefix stamped IDs with the frame's index (`f2-j5`), and keep the frame handle on each `PageElement`.
- Run every action through the element's frame: `frame.click`, `frame.fill`, `frame.press`, `frame.selectOption`.
- Tell Jev the frame's origin in the element description when it differs from the page's, for example `(inside frame from payments.example.com)`.
- Recheck the safety checks per frame:
  - Password fill compares against the frame's own origin, not the top page's.
  - Seeded cookies and the bot-protection check keep their current main-frame behaviour unless a test shows a gap.

**Tests to write first**
- A same-origin iframe holding a form. Its field is typed into and submitted.
- A cross-origin iframe, served from a second local port, holding a link. The link is offered and clicked.
- A hidden iframe. Its controls are not offered.
- A credential run with a password field inside a cross-origin iframe whose origin differs from the trusted origin. The fill is refused.

**Live check:** a public page with an embedded third-party form or search widget completes a task that needs a control inside the frame.

## Keyboard navigation inside menus

jev-browser presses only one key: Enter, as part of its search and submit actions. Menus built to the ARIA menu or combobox patterns expect more:
- A `role="menubar"` moves between items with the arrow keys.
- An autocomplete `role="combobox"` shows `role="option"` items that some sites only select with arrow keys and Enter.
- Escape closes a menu that was opened by mistake.

The element scan also leaves out these roles. `SEL` lists `a`, `button`, `input`, `textarea`, `select` and the roles `button`, `link`, `searchbox` and `textbox`. A `role="menuitem"` or `role="option"` that is a `<div>` or `<li>` is therefore never offered, even when it is visible.

**Change, in two steps**
1. Add `menuitem`, `menuitemcheckbox`, `menuitemradio`, `option`, `tab` and `combobox` to `SEL`. This alone lets Jev click most open menu and autocomplete items, so measure the gain before step 2.
2. When focus is inside a `menu`, `menubar`, `listbox` or `combobox`, offer these key actions, scoped to the focused element: `press_down`, `press_up`, `press_enter`, `press_escape`. Offer no other keys, so the action list stays small. Let the stuck watcher use `press_escape` as a recovery step when a menu opened by mistake blocks the page.

**Tests to write first**
- A `role="menubar"` whose items activate only through arrow keys and Enter. The target item is reached.
- An autocomplete combobox: type text, `role="option"` items appear, and the right one is picked.
- A menu opened by mistake is closed with Escape, and the next action succeeds.

**Live check:** a public site search with autocomplete suggestions picks a suggestion instead of submitting the raw text.

## Build order

The cheapest change with the widest effect goes first. The riskiest change goes last, because it touches the password and cookie safety checks.

| Order | Change | Size | Why this position |
|---|---|---|---|
| 1 | Menu and option roles added to `SEL` | Small, one line plus tests | Covers most menus and autocompletes without new actions |
| 2 | Shadow DOM scan | Small to medium | Clicking already works; only the scans change |
| 3 | Keyboard actions inside menus | Medium | New action kind, offered only in menu contexts |
| 4 | Iframes | Large | Every action and safety check becomes frame-aware |

## Working rules for these features

- Write the tests first, as local fixtures in `test/unit.test.mjs`, and confirm each one fails before the change.
- Run the whole suite on Helium with the OpenRouter key loaded:
  `set -a; . ~/.config/jev/openrouter.env; set +a; JEV_PROVIDER=openrouter npm test`
- Close each feature with its live check. Record the run's time, Jev cost and trace in the pull request or commit message.
- Update the limitations paragraph in `README.md` and add a line to `CHANGELOG.md` under "Unreleased (local)".
- Download no browser. Tests and runs use Helium through `resolveBrowserExecutable()`.
