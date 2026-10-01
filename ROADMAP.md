# Roadmap

All four planned features are built in this local fork (based on upstream 0.8.1). The menu and option roles landed in 77125d0, shadow DOM in 974e6ae, keyboard keys in menus in 3258ccc, and iframes in 7465f56. Four commits fixed problems the live checks exposed: fbf3db7 (load event), 603aabe (controls behind a modal), 0736bad (field values), and 7fe1029 (Helium warm-up). Each section below records what was built, how it differs from the original plan, the fixes the live check led to, and the live check result. Live checks used OpenRouter with `jev-1.13` on Helium.

## Menu and option roles

The element scan now offers `menuitem`, `menuitemcheckbox`, `menuitemradio`, `option`, `tab` and `combobox` elements (77125d0). Before, `SEL` listed only native controls and the roles `button`, `link`, `searchbox` and `textbox`, so a `<li role="option">` never reached the action list. The description names the role and whether `aria-selected` or `aria-checked` marks the item as chosen, so Jev can tell that a pick finished the task.

The live check exposed one fix. The first click on an option landed before the page's `load` event, when async scripts had not yet attached their handlers, so the selection registered only on a second click. `settle()` now also waits for `load`, capped at 5 s so ads and trackers cannot hold the run (fbf3db7).

Live check, W3C APG scrollable listbox, "select Neptunium" (2026-09-30): done in 5.5 s with 6 Jev calls at $0.0012 before the load-event fix, and in 7.7 s with 2 Jev calls at $0.0004 after it.

## Shadow DOM

Controls inside open shadow roots are now offered, including nested roots (974e6ae). The plan was a recursive helper over `element.shadowRoot`. The build instead routes every page scan through a Playwright locator, whose CSS engine searches open shadow roots. This covers the stamp-clearing pass, the element scan, the `settle()` fingerprint, the first-content wait, `menuSnapshot()` and the open-modal excerpt. Clicking needed no change, as planned.

The live check on Shoelace led to four fixes in the same commit:
- `aria-labelledby` ids resolve in the control's own root.
- A control whose label arrives through `<slot>` (Shoelace's `sl-button`) takes the slotted text as its name instead of being dropped as unlabelled.
- Component libraries that define elements after load (Shoelace's autoloader takes about 2 s) get a bounded 4 s wait before the first step.
- A modal inside a shadow root (`sl-dialog`) is the judged excerpt, read along the flat tree so slotted text is included.

A second finding led to 603aabe. A "Shoelace is now Web Awesome!" promo modal intercepted every click while Jev kept picking the control behind it. While a modal is open (`aria-modal="true"` or a native modal dialog), every control outside it is now described with "(behind an open dialog; close it first)".

Live check, shoelace.style/components/dialog (2026-09-30): all six "Open Dialog" `sl-button` elements are offered, where none were before. The run ended stuck after 17 s (3 Jev calls, $0.0010) until the modal marking arrived. With it, "Open the first example dialog on this page so that it is showing" ended done in 9.9 s with 3 Jev calls at $0.0012: Jev dismissed the promo with "No, thanks", then opened the example. The looser task "...and report the text shown inside the dialog" opened the dialog but the goal watcher did not fire, and the run toggled it until `max_steps`.

## Keyboard navigation inside menus

When focus is inside a `menu`, `menubar`, `listbox` or `combobox`, Jev is offered `press_down`, `press_up`, `press_enter` and `press_escape` (3258ccc). Focus is followed into shadow roots, and the action is described with the highlighted item. No other keys are offered.

Three details differ from the plan:
- A `menubar` also gets `press_right` and `press_left`, because its items sit side by side.
- Focus is checked again right before the press, so Enter cannot land on a form field outside the menu if focus moved while Jev decided.
- A highlight move is reported as an outcome (`highlighted "Contact"`), so a second `press_down` is not mistaken for a no-op by repeat recovery. When the stuck watcher fires while a menu has focus, Escape is pressed once instead of stopping the run.

The key actions are also offered for menus inside iframes (d55e023). Focus detection checks every frame, main frame first, and counts a child frame only while `document.hasFocus()` is true there; the key press goes to the focused frame. The keyboard tests check in-page effects rather than navigations, since a fresh Helium's built-in uBlock Origin (uBO) dropped fixture navigations at random.

The first live check ended at `max_steps` because Jev could not see that a field already held text. Field descriptions now carry the current value (`input "State" holding "Nevada"`), capped at 60 characters, redacted on credential runs, and never read for password fields (0736bad).

Live check, W3C APG autocomplete-list combobox, "type Ne and pick Nevada" (2026-10-01): before the value fix, typing, `press_down`, `press_enter` and option clicks all ran and Nevada ended selected, but the run hit `max_steps` after 8 Jev calls (18 s, $0.0014). After it, the run ended done in 4 steps (type, `press_down`, click the Nevada option, done) in 11.4 s with 4 Jev calls at $0.0008.

## Iframes

Every frame is now scanned and acted in (7465f56). The main frame goes first, so the page's own controls come first in the shared `MAX_ELEMENTS` budget. Child-frame ids carry the frame index (`f2-j5`), each element keeps its frame index, and click, fill, press, select, menu open and password fill all run in the element's own frame. A control from another origin is described as "inside frame from <host>". The origin is read from the frame with `window.origin`, because an `about:blank` frame inherits its parent's origin while its URL has none.

Deviations from the plan:
- `about:blank` frames are kept, not skipped. The W3Schools editor writes its result pane into one. Detached, hidden and smaller-than-50×50 px frames are still skipped.
- The visible frames' text is part of the judged excerpt (up to half of it), a change inside a frame counts as an effect ("content inside a frame changed"), and `settle()` waits for child frames to finish loading.
- The password fill compares against the frame's own origin, so a cross-origin frame is refused.

The unit suite had 125 passing tests after this commit. The new ones cover a form in a same-origin frame (typed into and submitted), a link in a cross-origin frame (offered with its host and clicked), hidden, tiny and blank frames, the password-fill refusal in a cross-origin frame, and frame text being judged.

Live check, W3Schools tryit "submit the form" (the form sits in the `iframeResult` frame, 2026-10-01): done in 2 steps, 14.3 s including the 6 s Helium warm-up, 2 Jev calls, $0.0001.

## Helium warm-up

A freshly launched Helium delays navigations, and 7fe1029 adds a warm-up that avoids it. Helium ships uBlock Origin, which holds a click's navigation for its first seconds and then reloads the tab, so the navigation arrived about 2.5 s late, loaded twice, or was lost. A plain Playwright script that clicks at once after launching Helium does the same, and Playwright's headless shell (no uBO) does not.

On Helium 0.18.1.1 (Chromium 154), uBO reports `readyToFilter` about 4.5 s after launch, but clicks within about 2.7 s of the first real page load are still held. `launchWarmBrowser()` waits for uBO (found over CDP), loads one throwaway page from a loopback server, and returns 6 s after launch. With that, clicks in fresh contexts reach the server in about 90 ms (two runs of four); with a 4 s wait the first click was still held 1.3 s. `keepBrowserOpen()` keeps one warmed browser per process and relaunches it after a crash. The MCP stdio and HTTP servers call it at startup, and each run creates and closes its own context, so no cookies or storage are shared. A test requires a link clicked at the first step to reach the server within 1 s, once; it took about 2.4 s before.

## Open items

Closed shadow roots stay unreachable by design, because the browser gives page scripts no access to them.

CLI runs no longer pay the warm-up each time: `jev-browser run` connects to a warm background Helium that starts on first use and exits after 15 idle minutes, so a run starts in about 0.4 s instead of about 7 s. Runs with a password, seed cookies or `--record` still launch their own browser and pay the 6 s, as do direct `navigate()` calls without the `browser` option or `keepBrowserOpen()`.

The bot-protection check and seeded cookies remain main-frame only. A challenge or cookie requirement inside an iframe is not detected or satisfied.

The judged excerpt for credential runs does not include frame text, so a task whose result appears only inside an iframe cannot be judged done on a credential run.
