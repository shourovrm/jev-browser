import assert from "node:assert/strict";
import { after, test } from "node:test";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import {
  buildActionSpace,
  buildKeyActions,
  buildCriteria,
  detectBotProtection,
  heuristicQuery,
  isNoiseHref,
  isNoiseName,
  MAX_ELEMENTS,
  parseCookieSpec,
  pickAlternate,
  resolveBrowserExecutable,
  resolveCookies,
  HELIUM_EXECUTABLE_PATH,
} from "../dist/lib.js";
import { closeSharedBrowser, keepBrowserOpen, navigate } from "../dist/navigate.js";

// One warmed browser for the whole file, the way the servers run: a fresh
// launch per test would pay Helium's uBlock Origin warm-up every time.
keepBrowserOpen();
after(closeSharedBrowser);
import { OPENROUTER_PRIVACY_FILTER, resolvePrivateTransport } from "../dist/provider.js";

test("resolvePrivateTransport: OpenRouter Jev calls carry the no-training, zero-retention filter", async (t) => {
  const sentBodies = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    sentBodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ answers: { q: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 5 } }));
  });
  const transport = resolvePrivateTransport({ JEV_PROVIDER: "openrouter", OPENROUTER_API_KEY: "sk-or-test" });
  const reply = await transport.ask({ state: "s", questions: {}, model: "jev-latest", signal: new AbortController().signal });
  assert.equal(transport.name, "openrouter");
  assert.deepEqual(sentBodies[0].provider, OPENROUTER_PRIVACY_FILTER);
  assert.equal(sentBodies[0].model, "typesafe/jev-1.13");
  assert.deepEqual(reply.usage, { input_tokens: 5, output_tokens: 0 });
});

test("navigate waits for a blank interstitial to reload into the real page before offering elements", async (t) => {
  // Mimics nsf.gov: a blank, untitled page runs a script, then reloads into the real page.
  const http = await import("node:http");
  const server = http.createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    if (request.url === "/real") {
      response.end("<title>Real page</title><a href='/next'>Next page</a><button>Search</button>");
    } else {
      response.end("<html><body><script>setTimeout(() => location.replace('/real'), 1200)</script></body></html>");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  let offeredElementCount = null;
  const probeTransport = {
    name: "fixture",
    async ask({ state }) {
      offeredElementCount = (typeof state === "string" ? JSON.parse(state) : state).interactive_elements.length;
      throw new Error("probe stop");
    },
  };
  try {
    await navigate({
      task: "Open the next page",
      startUrl: `http://127.0.0.1:${server.address().port}/`,
      transport: probeTransport,
      maxSteps: 1,
      maxSeconds: 20,
      screenshot: "none",
    });
  } catch (error) {
    if (String(error).includes("Executable doesn't exist")) {
      t.skip("Playwright browser binary is not installed");
      return;
    }
    throw error;
  }
  assert.equal(offeredElementCount, 2);
});

test("buildActionSpace describes menu toggles and their open/closed state", () => {
  const closedMenu = el({ attr: "j1", tag: "button", text: "Find Funding", href: "", menu: "closed" });
  const openMenu = el({ attr: "j2", tag: "button", text: "About", href: "", menu: "open" });
  const { elements } = buildActionSpace([closedMenu, openMenu]);
  assert.equal(elements[0].kind, "click");
  assert.equal(elements[0].description, 'button "Find Funding" (menu, closed; clicking shows its items)');
  assert.equal(elements[1].description, 'button "About" (menu, open)');
});

async function runMenuScenario(t, pageHtml, labelsToClick, scripts = {}, { stuckAtSteps = [], navigateOptions = {} } = {}) {
  // Step N clicks the control whose description holds labelsToClick[N-1]; the
  // step after the last label records what is offered and answers done.
  const http = await import("node:http");
  const server = http.createServer((request, response) => {
    const script = scripts[request.url];
    if (script) {
      response.setHeader("Content-Type", script.contentType ?? "text/javascript");
      setTimeout(() => response.end(script.body), script.delayMs);
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(pageHtml);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.closeAllConnections?.() ?? server.close());
  const offeredPerStep = [];
  const statesPerStep = [];
  const transport = {
    name: "fixture",
    async ask({ state, questions }) {
      const parsed = typeof state === "string" ? JSON.parse(state) : state;
      statesPerStep.push(parsed);
      offeredPerStep.push(parsed.interactive_elements.map((element) => element.description));
      const answers = {};
      for (const [id, question] of Object.entries(questions)) {
        if (question.type === "noul") {
          const stuck = id === "stuck" && stuckAtSteps.includes(offeredPerStep.length);
          answers[id] = { type: "noul", noul: stuck ? 0.95 : 0 };
          continue;
        }
        const keys = Object.keys(question.criteria);
        const wantedLabel = labelsToClick[offeredPerStep.length - 1];
        const wantedKey = wantedLabel ? keys.find((key) => question.criteria[key].includes(wantedLabel)) : undefined;
        const pick = wantedKey ?? "done";
        answers[id] = { type: "choice", choice: pick, confidence: 1, probabilities: Object.fromEntries(keys.map((key) => [key, key === pick ? 1 : 0])) };
      }
      return { answers, usage: { input_tokens: 1, output_tokens: 1 }, model: "fixture" };
    },
  };
  const origin = `http://127.0.0.1:${server.address().port}`;
  const result = await navigate({
    task: "Open the Award Search page",
    startUrl: `${origin}/`,
    transport,
    maxSteps: labelsToClick.length + 1,
    maxSeconds: 30,
    screenshot: "none",
    // A function receives the page origin, for options that must name it.
    ...(typeof navigateOptions === "function" ? navigateOptions(origin) : navigateOptions),
  });
  return { offeredPerStep, statesPerStep, result };
}

test("a menu whose script loads late still opens: jev-browser waits and clicks again", async (t) => {
  // Like nsf.gov: the toggle ignores clicks until the site's menu script has downloaded.
  const pageHtml = `<!doctype html><title>Late menu</title><p>Welcome</p>
    <button id="toggle" aria-expanded="false" aria-controls="menu">Products</button>
    <ul id="menu" style="display:none"><li><a href="/awards">Award Search</a></li></ul>
    <script src="/menu.js" async></script>`;
  const menuScript = `document.getElementById("toggle").addEventListener("click", () => {
    document.getElementById("menu").style.display = "block";
    document.getElementById("toggle").setAttribute("aria-expanded", "true");
  });`;
  const { offeredPerStep, result } = await runMenuScenario(t, pageHtml, ["Products"], { "/menu.js": { body: menuScript, delayMs: 2500 } });
  assert.ok(offeredPerStep[0].some((description) => description.includes("(menu, closed")), "step 1 should describe the toggle as a closed menu");
  assert.ok(offeredPerStep[1].some((description) => description.includes("Award Search")), "the menu item should be offered after the click");
  assert.match(result.steps[0].detail, /opened menu/);
});

test("a hover-only menu opens by hovering when clicking does nothing", async (t) => {
  const pageHtml = `<!doctype html><title>Hover menu</title><style>
    .nav .sub { display: none } .nav:hover .sub { display: block }</style><p>Welcome</p>
    <div class="nav"><button aria-haspopup="true">Products</button>
    <ul class="sub"><li><a href="/awards">Award Search</a></li></ul></div>`;
  const { offeredPerStep, result } = await runMenuScenario(t, pageHtml, ["Products"]);
  assert.ok(offeredPerStep[1].some((description) => description.includes("Award Search")), "the menu item should be offered after hovering");
  assert.match(result.steps[0].detail, /opened menu by hovering/);
});

test("buildActionSpace tells Jev which controls are menu items, list options and tabs", () => {
  const { elements } = buildActionSpace([
    el({ attr: "j1", tag: "li", role: "menuitem", text: "Award Search", href: "" }),
    el({ attr: "j2", tag: "div", role: "option", text: "Espresso", href: "" }),
    el({ attr: "j3", tag: "div", role: "tab", text: "Details", href: "" }),
    el({ attr: "j4", tag: "a", role: "menuitemcheckbox", text: "Show archived", href: "" }),
  ]);
  assert.deepEqual(
    elements.map((element) => element.description),
    ['li "Award Search" (menu item)', 'div "Espresso" (option in a list)', 'div "Details" (tab)', 'a "Show archived" (menu item)'],
  );
});

test("buildActionSpace says which option, tab or checkable menu item is selected", () => {
  const { elements } = buildActionSpace([
    el({ attr: "j1", tag: "li", role: "option", text: "Neptunium", href: "", selected: true }),
    el({ attr: "j2", tag: "div", role: "tab", text: "Hours", href: "", selected: true }),
    el({ attr: "j3", tag: "li", role: "menuitemcheckbox", text: "Show archived", href: "", selected: true }),
    el({ attr: "j4", tag: "li", role: "option", text: "Plutonium", href: "", selected: false }),
  ]);
  assert.deepEqual(
    elements.map((element) => element.description),
    ['li "Neptunium" (option in a list, selected)', 'div "Hours" (tab, selected)', 'li "Show archived" (menu item, selected)', 'li "Plutonium" (option in a list)'],
  );
});

test("the scan reads aria-selected and aria-checked into the selected state", async (t) => {
  const pageHtml = `<!doctype html><title>Listbox</title><ul role="listbox">
    <li role="option" aria-selected="true">Neptunium</li><li role="option" aria-selected="false">Plutonium</li></ul>
    <ul role="menu"><li role="menuitemcheckbox" aria-checked="true">Show archived</li></ul>`;
  const { offeredPerStep } = await runMenuScenario(t, pageHtml, []);
  assert.ok(offeredPerStep[0].includes('li "Neptunium" (option in a list, selected)'));
  assert.ok(offeredPerStep[0].includes('li "Plutonium" (option in a list)'));
  assert.ok(offeredPerStep[0].includes('li "Show archived" (menu item, selected)'));
});

test("menu items that are plain list elements are offered and clicked", async (t) => {
  const pageHtml = `<!doctype html><title>Menubar</title><p>Welcome</p>
    <ul role="menubar"><li role="menuitem" tabindex="0" onclick="location.href='/awards'">Award Search</li>
    <li role="menuitem" tabindex="-1">Funding</li></ul>`;
  const { offeredPerStep, result } = await runMenuScenario(t, pageHtml, ["Award Search"]);
  assert.ok(offeredPerStep[0].includes('li "Award Search" (menu item)'), "the menu item should be offered");
  assert.match(result.final_url, /\/awards$/);
});

test("autocomplete options that are plain divs are offered and picked", async (t) => {
  const pageHtml = `<!doctype html><title>Autocomplete</title><p>Pick a drink</p>
    <div role="combobox" tabindex="0" aria-expanded="false" aria-controls="list" id="box"
      onclick="document.getElementById('list').hidden = false; this.setAttribute('aria-expanded', 'true')">Choose a drink</div>
    <div role="listbox" id="list" hidden>
      <div role="option" onclick="location.href='/tea'">Tea</div>
      <div role="option" onclick="location.href='/espresso'">Espresso</div>
    </div>`;
  const { offeredPerStep, result } = await runMenuScenario(t, pageHtml, ["Choose a drink", "Espresso"]);
  assert.ok(offeredPerStep[1].includes('div "Espresso" (option in a list)'), "the option should be offered once the list is open");
  assert.match(result.final_url, /\/espresso$/);
});

test("tabs that are plain divs are offered and switch the panel", async (t) => {
  const pageHtml = `<!doctype html><title>Tabs</title>
    <div role="tablist"><div role="tab" aria-selected="true">Overview</div>
    <div role="tab" onclick="document.getElementById('panel').textContent = 'Opening hours: 9 to 5'">Hours</div></div>
    <div id="panel">Welcome to the cafe</div>`;
  const { result } = await runMenuScenario(t, pageHtml, ["Hours"]);
  assert.equal(result.steps[0].detail, 'div "Hours" (tab)');
});

test("the first click waits for the page's load event, so late scripts have attached their handlers", async (t) => {
  // Like the W3C listbox example: the option only reacts once an async script has run.
  const pageHtml = `<!doctype html><title>Late handlers</title><p>Pick a drink</p>
    <ul role="listbox"><li role="option" id="tea">Tea</li><li role="option" id="espresso">Espresso</li></ul>
    <script src="/listbox.js" async></script>`;
  const listboxScript = `document.getElementById("espresso").addEventListener("click", () => { location.href = "/espresso"; });`;
  const { result } = await runMenuScenario(t, pageHtml, ["Espresso"], { "/listbox.js": { body: listboxScript, delayMs: 2500 } });
  assert.match(result.final_url, /\/espresso$/);
});

// Web components for the shadow DOM tests: <open-card> holds a button and a
// link in an open root, <outer-panel> nests <open-card>-like content two roots
// deep, and <closed-card> hides its link in a closed root.
const shadowComponents = `<script>
  customElements.define("open-card", class extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" }).innerHTML =
        '<span id="caption">Order a coffee</span><button aria-labelledby="caption" onclick="location.href=\\'/ordered\\'"></button><a href="/menu">Full menu</a>';
    }
  });
  customElements.define("inner-panel", class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = '<a href="/hours">Opening hours</a>'; }
  });
  customElements.define("outer-panel", class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = '<p>Visit us</p><inner-panel></inner-panel>'; }
  });
  customElements.define("slot-button", class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = '<button onclick="location.href=\\'/booked\\'"><slot></slot></button>'; }
  });
  customElements.define("promo-dialog", class extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" }).innerHTML =
        '<div role="dialog" aria-modal="true"><h2>Big news</h2><slot></slot><style>h2 { margin: 0 }</style></div>';
    }
  });
  customElements.define("closed-card", class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: "closed" }).innerHTML = '<a href="/secret">Hidden offer</a>'; }
  });
</script>`;

test("controls inside an open shadow root are offered, labelled from their own root, and clickable", async (t) => {
  const pageHtml = `<!doctype html><title>Cafe</title><p>Welcome</p><open-card></open-card>${shadowComponents}`;
  const { offeredPerStep, result } = await runMenuScenario(t, pageHtml, ["Order a coffee"]);
  assert.ok(offeredPerStep[0].includes('button "Order a coffee"'), "the button should be offered with its aria-labelledby name");
  assert.ok(offeredPerStep[0].some((description) => description.startsWith('a "Full menu"')), "the link should be offered");
  assert.match(result.final_url, /\/ordered$/);
});

test("controls in a shadow root nested inside another shadow root are offered", async (t) => {
  const pageHtml = `<!doctype html><title>Cafe</title><p>Welcome</p><outer-panel></outer-panel>${shadowComponents}`;
  const { offeredPerStep } = await runMenuScenario(t, pageHtml, []);
  assert.ok(offeredPerStep[0].some((description) => description.startsWith('a "Opening hours"')));
});

test("a shadow control labelled through a slot takes the slotted text as its name", async (t) => {
  // Like Shoelace's <sl-button>: the inner <button> holds only a <slot>, so
  // its own innerText and textContent are empty.
  const pageHtml = `<!doctype html><title>Cafe</title><p>Welcome</p><slot-button>Book a table</slot-button>${shadowComponents}`;
  const { offeredPerStep, result } = await runMenuScenario(t, pageHtml, ["Book a table"]);
  assert.ok(offeredPerStep[0].includes('button "Book a table"'));
  assert.match(result.final_url, /\/booked$/);
});

test("the first step waits for custom elements that are defined after the load event", async (t) => {
  // Like Shoelace's autoloader: components are defined a moment after load.
  const lateDefinition = shadowComponents.replace("<script>", "<script>setTimeout(() => {").replace("</script>", "}, 1500)</script>");
  const pageHtml = `<!doctype html><title>Cafe</title><p>Welcome</p><slot-button>Book a table</slot-button>${lateDefinition}`;
  const { offeredPerStep } = await runMenuScenario(t, pageHtml, []);
  assert.ok(offeredPerStep[0].includes('button "Book a table"'));
});

test("a modal dialog inside a shadow root is the judged excerpt, slotted text included", async (t) => {
  // Like Shoelace's <sl-dialog>: the aria-modal element is in the shadow root
  // and the message is light-DOM content shown through a slot.
  const pageHtml = `<!doctype html><title>Cafe</title><p>Welcome to the cafe</p>
    <promo-dialog><p>We moved to a new address</p><button>No, thanks</button></promo-dialog>${shadowComponents}`;
  const { statesPerStep } = await runMenuScenario(t, pageHtml, []);
  const excerpt = statesPerStep[0].page_text_excerpt;
  assert.match(excerpt, /Big news/);
  assert.match(excerpt, /We moved to a new address/);
  assert.doesNotMatch(excerpt, /Welcome to the cafe|margin/);
});

test("buildActionSpace marks controls that sit behind an open modal dialog", () => {
  const { elements } = buildActionSpace([
    el({ attr: "j1", tag: "button", text: "Open Dialog", href: "", behindModal: true }),
    el({ attr: "j2", tag: "button", text: "No, thanks", href: "" }),
  ]);
  assert.equal(elements[0].description, 'button "Open Dialog" (behind an open dialog; close it first)');
  assert.equal(elements[1].description, 'button "No, thanks"');
});

test("controls outside a native modal dialog are marked as behind it", async (t) => {
  const pageHtml = `<!doctype html><title>Cafe</title><a href="/menu">Full menu</a>
    <dialog id="d"><p>Accept cookies?</p><button>Accept</button></dialog><script>document.getElementById("d").showModal()</script>`;
  const { offeredPerStep } = await runMenuScenario(t, pageHtml, []);
  assert.ok(offeredPerStep[0].some((description) => description.startsWith('a "Full menu"') && description.endsWith("(behind an open dialog; close it first)")));
  assert.ok(offeredPerStep[0].includes('button "Accept"'));
});

test("slotted controls of a modal inside a shadow root are not marked; the page behind it is", async (t) => {
  const pageHtml = `<!doctype html><title>Cafe</title><p>Welcome</p><slot-button>Book a table</slot-button>
    <promo-dialog><p>We moved to a new address</p><button>No, thanks</button></promo-dialog>${shadowComponents}`;
  const { offeredPerStep } = await runMenuScenario(t, pageHtml, []);
  assert.ok(offeredPerStep[0].includes('button "No, thanks"'));
  assert.ok(offeredPerStep[0].includes('button "Book a table" (behind an open dialog; close it first)'));
});

test("with no modal open, nothing is marked as behind one", async (t) => {
  const pageHtml = `<!doctype html><title>Cafe</title><a href="/menu">Full menu</a><dialog id="d"><button>Accept</button></dialog>
    <script>document.getElementById("d").show()</script>`;
  const { offeredPerStep } = await runMenuScenario(t, pageHtml, []);
  assert.ok(!offeredPerStep[0].some((description) => description.includes("behind an open dialog")));
});

test("controls in a closed shadow root are not offered and the run does not error", async (t) => {
  const pageHtml = `<!doctype html><title>Cafe</title><p>Welcome</p><a href="/about">About us</a><closed-card></closed-card>${shadowComponents}`;
  const { offeredPerStep, result } = await runMenuScenario(t, pageHtml, []);
  assert.equal(result.status, "done");
  assert.ok(offeredPerStep[0].some((description) => description.startsWith('a "About us"')));
  assert.ok(!offeredPerStep[0].some((description) => description.includes("Hidden offer")));
});

test("a page rendered entirely inside a component still counts as content", async (t) => {
  // No light-DOM text or controls at all: waitForFirstContent and settle must
  // see the component's controls, or the run waits out its full timeout.
  const pageHtml = `<!doctype html><title>App</title><open-card></open-card>${shadowComponents}`;
  const { result } = await runMenuScenario(t, pageHtml, []);
  assert.equal(result.status, "done");
  assert.ok(result.elapsed_ms < 8_000, `run took ${result.elapsed_ms} ms`);
});

test("buildKeyActions offers menu keys only when focus is inside a menu, and arrows that match its layout", () => {
  assert.deepEqual(buildKeyActions(null), {});
  const listbox = buildKeyActions({ role: "listbox", label: "Drinks", activeItem: "Tea" });
  assert.deepEqual(Object.keys(listbox), ["press_down", "press_up", "press_enter", "press_escape"]);
  assert.equal(listbox.press_enter, 'Press Enter in the focused listbox "Drinks" (highlighted: "Tea"): activates the highlighted item');
  const menubar = buildKeyActions({ role: "menubar", label: "", activeItem: "Home" });
  assert.deepEqual(Object.keys(menubar), ["press_right", "press_left", "press_down", "press_up", "press_enter", "press_escape"]);
  assert.match(menubar.press_right, /^Press the Right arrow key in the focused menubar \(highlighted: "Home"\): /);
});

test("buildCriteria appends the key actions before the loop controls", () => {
  const keyActions = buildKeyActions({ role: "menu", label: "Products", activeItem: "" });
  const criteria = buildCriteria([], keyActions);
  assert.deepEqual(Object.keys(criteria), ["press_down", "press_up", "press_enter", "press_escape", "scroll_down", "scroll_up", "back", "done"]);
});

// The keyboard tests check in-page effects rather than navigations: in a
// freshly launched Helium, the built-in uBlock Origin holds navigation
// requests for the first few seconds and then reloads the tab, which can
// drop a navigation that a multi-step fixture starts in that window.

// A horizontal menubar with a roving tabindex: clicks only focus an item;
// arrow keys move between items and Enter opens the focused one.
const keyboardMenubar = `<!doctype html><title>Keyboard menubar</title><p>Welcome</p>
  <ul role="menubar" id="bar">
    <li role="menuitem" tabindex="0">Home</li>
    <li role="menuitem" tabindex="-1">About</li>
    <li role="menuitem" tabindex="-1">Contact</li>
  </ul>
  <p id="opened"></p>
  <script>
    const items = [...document.querySelectorAll("#bar [role=menuitem]")];
    document.getElementById("bar").addEventListener("keydown", (event) => {
      const index = items.indexOf(document.activeElement);
      if (event.key === "ArrowRight") items[(index + 1) % items.length].focus();
      if (event.key === "ArrowLeft") items[(index + items.length - 1) % items.length].focus();
      if (event.key === "Enter") document.getElementById("opened").textContent = "Opened the " + document.activeElement.textContent + " page";
    });
  </script>`;

test("a menubar that only responds to arrow keys and Enter reaches its target item", async (t) => {
  const { offeredPerStep, result } = await runMenuScenario(t, keyboardMenubar, ["Home", "Right arrow", "Right arrow", "Press Enter"]);
  assert.ok(!offeredPerStep[0].some((description) => description.startsWith("Press ")), "no key actions before focus is in the menubar");
  assert.equal(result.steps[1].executed_action, "press_right");
  assert.equal(result.steps[2].executed_action, "press_right", "a repeated arrow key that moved the highlight is not switched away by repeat recovery");
  assert.equal(result.steps[2].outcome, 'highlighted "Contact"');
  assert.match(result.page.content, /Opened the Contact page/);
});

test("an autocomplete combobox picks a suggestion with arrow keys and Enter", async (t) => {
  const pageHtml = `<!doctype html><title>Autocomplete</title>
    <input role="combobox" aria-label="Drink" aria-controls="list" aria-expanded="true" value="e" autofocus>
    <ul role="listbox" id="list"><li role="option" id="tea">Tea</li><li role="option" id="espresso">Espresso</li></ul>
    <p id="picked"></p>
    <script>
      const input = document.querySelector("input");
      const options = [...document.querySelectorAll("[role=option]")];
      let active = -1;
      input.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown") active = Math.min(active + 1, options.length - 1);
        if (event.key === "ArrowUp") active = Math.max(active - 1, 0);
        if (active >= 0) input.setAttribute("aria-activedescendant", options[active].id);
        if (event.key === "Enter" && active >= 0) document.getElementById("picked").textContent = "Picked " + options[active].textContent;
      });
    </script>`;
  const { result } = await runMenuScenario(t, pageHtml, ["Down arrow", "Down arrow", "Press Enter"]);
  assert.deepEqual(result.steps.slice(0, 3).map((step) => step.executed_action), ["press_down", "press_down", "press_enter"]);
  assert.equal(result.steps[1].outcome, 'highlighted "Espresso"');
  assert.match(result.page.content, /Picked Espresso/);
});

// A menu that covers the page when opened and closes on Escape.
const menuOpenedByMistake = `<!doctype html><title>Covering menu</title>
  <button id="toggle" aria-haspopup="menu" aria-expanded="false">Products</button>
  <button id="contact" style="position: absolute; top: 200px"
    onclick="document.getElementById('reply').textContent = 'Call us on 555 0100'">Contact us</button>
  <p id="reply" style="position: absolute; top: 260px"></p>
  <ul role="menu" id="menu" hidden style="position: fixed; inset: 40px 0 0 0; background: white; margin: 0">
    <li role="menuitem" tabindex="-1">Coffee beans</li><li role="menuitem" tabindex="-1">Grinders</li>
  </ul>
  <script>
    const toggle = document.getElementById("toggle");
    const menu = document.getElementById("menu");
    toggle.addEventListener("click", () => {
      menu.hidden = false;
      toggle.setAttribute("aria-expanded", "true");
      menu.querySelector("[role=menuitem]").focus();
    });
    menu.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      menu.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
      toggle.focus();
    });
  </script>`;

test("a menu opened by mistake is closed with Escape and the next action succeeds", async (t) => {
  const { result } = await runMenuScenario(t, menuOpenedByMistake, ["Products", "Press Escape", "Contact us"]);
  assert.equal(result.steps[1].executed_action, "press_escape");
  assert.match(result.page.content, /Call us on 555 0100/);
});

test("when the stuck watcher fires while a menu has focus, Escape is pressed once instead of stopping", async (t) => {
  const { result } = await runMenuScenario(t, menuOpenedByMistake, ["Products", "Scroll down", "Contact us", "Contact us"], {}, { stuckAtSteps: [3] });
  assert.equal(result.steps[2].proposed_action.startsWith("click_"), true);
  assert.equal(result.steps[2].executed_action, "press_escape");
  assert.match(result.steps[2].recovery_reason, /stuck watcher fired while a menu had focus/);
  assert.match(result.page.content, /Call us on 555 0100/);
});

test("the stuck watcher still stops the run when no menu has focus", async (t) => {
  const { result } = await runMenuScenario(t, keyboardMenubar, ["Scroll down", "Scroll down", "Scroll down"], {}, { stuckAtSteps: [3] });
  assert.equal(result.status, "stuck");
});

test("buildActionSpace shows what a text field already holds", () => {
  const { elements } = buildActionSpace([
    el({ attr: "j1", tag: "input", role: "combobox", text: "State", href: "", clickable: false, typeable: true, value: "Nevada" }),
    el({ attr: "j2", tag: "input", role: "input", text: "Search", href: "", clickable: false, typeable: true, searchField: true, value: "" }),
  ]);
  assert.equal(elements[0].description, 'input "State" holding "Nevada" (type without submitting)');
  assert.equal(elements[1].description, 'input "Search" (type into this search box and run the search)');
});

test("the scan reads the current value of inputs and textareas, never of password fields", async (t) => {
  const pageHtml = `<!doctype html><title>Form</title><label>State <input value="Nevada"></label>
    <label for="notes">Notes</label> <textarea id="notes">Leave at the door</textarea><label>Password <input type="password" value="hunter22"></label>`;
  const { offeredPerStep } = await runMenuScenario(t, pageHtml, []);
  assert.ok(offeredPerStep[0].includes('input "State" holding "Nevada" (type without submitting)'));
  assert.ok(offeredPerStep[0].includes('textarea "Notes" holding "Leave at the door" (type without submitting)'));
  assert.ok(!offeredPerStep[0].some((description) => description.includes("hunter22")));
});

test("a link clicked at the first step of a fresh browser navigates at once, and exactly once", async (t) => {
  // Helium's built-in uBlock Origin holds navigations for its first seconds,
  // then reloads the tab: an early click was delayed, repeated or lost.
  const http = await import("node:http");
  const requests = [];
  let nextArrivedAt = null;
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    if (request.url === "/next") nextArrivedAt ??= performance.now();
    response.setHeader("Content-Type", "text/html");
    response.end(request.url === "/next" ? "<title>Next</title><p>Arrived</p>" : "<title>Start</title><a href='/next'>Next page</a>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.closeAllConnections?.() ?? server.close());
  let calls = 0;
  const transport = {
    name: "fixture",
    async ask({ questions }) {
      calls++;
      const answers = {};
      for (const [id, question] of Object.entries(questions)) {
        if (question.type === "noul") {
          answers[id] = { type: "noul", noul: 0 };
          continue;
        }
        const keys = Object.keys(question.criteria);
        const pick = calls === 1 ? keys.find((key) => question.criteria[key].includes("Next page")) : "done";
        answers[id] = { type: "choice", choice: pick, confidence: 1, probabilities: Object.fromEntries(keys.map((key) => [key, key === pick ? 1 : 0])) };
      }
      return { answers, usage: { input_tokens: 1, output_tokens: 1 }, model: "fixture" };
    },
  };
  const runStartedAt = performance.now();
  const result = await navigate({ task: "Open the next page", startUrl: `http://127.0.0.1:${server.address().port}/`, transport, maxSteps: 2, screenshot: "none" });
  const requestDelayMs = nextArrivedAt - (runStartedAt + result.steps[0].t_ms);
  assert.ok(requestDelayMs < 1_000, `the click's request reached the server ${Math.round(requestDelayMs)} ms after the step began`);
  assert.match(result.final_url, /\/next$/);
  assert.equal(result.steps[0].outcome, `navigated to http://127.0.0.1:${server.address().port}/next`);
  assert.equal(requests.filter((url) => url === "/next").length, 1);
});

// Iframe fixtures. A page served from 127.0.0.1 embeds localhost for a
// cross-origin frame: same port, different host, so a different origin and
// site. Frames report back to the page by setting its title through
// postMessage, an in-page effect that works across origins.
const htmlPage = (body) => ({ body, delayMs: 0, contentType: "text/html" });
const reportToParent = `<script>const report = (text) => parent.postMessage(text, "*");</script>`;
const titleFromMessages = `<script>addEventListener("message", (event) => { document.title = String(event.data); });</script>`;
const crossOriginFrame = (path, style = "width: 500px; height: 220px") =>
  `<iframe id="frame" style="${style}"></iframe>
   <script>document.getElementById("frame").src = location.origin.replace("127.0.0.1", "localhost") + "${path}";</script>`;

test("a form inside a same-origin iframe is typed into and submitted", async (t) => {
  // Typing goes through a mocked OpenAI-compatible endpoint, so no network call is made.
  const previousBaseUrl = process.env.JEV_BROWSER_TYPE_BASE_URL;
  process.env.JEV_BROWSER_TYPE_BASE_URL = "http://typing.test/v1";
  t.after(() => {
    if (previousBaseUrl === undefined) delete process.env.JEV_BROWSER_TYPE_BASE_URL;
    else process.env.JEV_BROWSER_TYPE_BASE_URL = previousBaseUrl;
  });
  t.mock.method(globalThis, "fetch", async () => chatCompletion("ada@example.com"));
  const pageHtml = `<!doctype html><title>Cafe</title><p>Join our newsletter</p>
    <iframe src="/signup" style="width: 500px; height: 220px"></iframe>${titleFromMessages}`;
  const signup = `<!doctype html>${reportToParent}
    <form onsubmit="event.preventDefault(); report('Subscribed ' + this.email.value)">
      <label>Email <input name="email"></label><button>Subscribe</button></form>`;
  const { offeredPerStep, result } = await runMenuScenario(t, pageHtml, ["Email", "Subscribe"], { "/signup": htmlPage(signup) });
  assert.ok(offeredPerStep[0].includes('input "Email" (type without submitting)'), "same-origin frames get no origin note");
  assert.equal(result.steps[0].detail, 'typed "ada@example.com" via compatible-endpoint');
  assert.equal(result.final_title, "Subscribed ada@example.com");
});

test("a link inside a cross-origin iframe is offered with the frame's origin and clicked", async (t) => {
  const pageHtml = `<!doctype html><title>Cafe</title><p>Today's offer</p>${crossOriginFrame("/widget")}${titleFromMessages}`;
  const widget = `<!doctype html>${reportToParent}<a href="/offer" onclick="event.preventDefault(); report('Offer opened')">Open the offer</a>`;
  const { offeredPerStep, result } = await runMenuScenario(t, pageHtml, ["Open the offer"], { "/widget": htmlPage(widget) });
  const offer = offeredPerStep[0].find((description) => description.startsWith('a "Open the offer"'));
  assert.match(offer, /\(inside frame from localhost:\d+\)$/);
  assert.equal(result.final_title, "Offer opened");
});

test("text inside a visible frame is judged, and a change inside it counts as an effect", async (t) => {
  const pageHtml = `<!doctype html><title>Cafe</title><p>Order online</p>
    <iframe src="/order" style="width: 500px; height: 220px"></iframe>`;
  const order = `<!doctype html><form action="/thanks"><button>Place order</button></form>`;
  const thanks = `<!doctype html><p>Thank you, your order number is 4417 and it will be ready in twenty minutes.</p>`;
  const { statesPerStep, result } = await runMenuScenario(t, pageHtml, ["Place order"], { "/order": htmlPage(order), "/thanks?": htmlPage(thanks) });
  assert.match(statesPerStep[0].page_text_excerpt, /Order online/);
  assert.equal(result.steps[0].outcome, "content inside a frame changed");
  assert.match(statesPerStep[1].page_text_excerpt, /Frame: Thank you, your order number is 4417/);
});

test("a menubar inside an iframe gets the same key actions once focus is in it", async (t) => {
  const pageHtml = `<!doctype html><title>Cafe</title><p>Navigation below</p>
    <iframe src="/nav" style="width: 500px; height: 220px"></iframe>`;
  const { statesPerStep, result } = await runMenuScenario(t, pageHtml, ["Home", "Right arrow", "Press Enter"], { "/nav": htmlPage(keyboardMenubar) });
  assert.deepEqual(result.steps.slice(0, 3).map((step) => step.executed_action.replace(/_e\d+$/, "")), ["click", "press_right", "press_enter"]);
  assert.equal(result.steps[1].outcome, 'highlighted "About"');
  assert.match(statesPerStep[3].page_text_excerpt, /Frame: .*Opened the About page/);
});

test("controls in hidden, tiny and blank iframes are not offered", async (t) => {
  const pageHtml = `<!doctype html><title>Cafe</title><a href="/about">About us</a>
    <iframe src="/tracker" style="display: none"></iframe>
    <iframe src="/tracker" style="width: 20px; height: 20px"></iframe>
    <iframe src="about:blank" style="width: 500px; height: 200px"></iframe>`;
  const tracker = `<!doctype html><a href="/pixel">Tracking pixel link</a>`;
  const { offeredPerStep, result } = await runMenuScenario(t, pageHtml, [], { "/tracker": htmlPage(tracker) });
  assert.equal(result.status, "done");
  assert.ok(offeredPerStep[0].some((description) => description.startsWith('a "About us"')));
  assert.ok(!offeredPerStep[0].some((description) => description.includes("Tracking pixel")));
});

test("a password field inside a frame is filled only when the frame's own origin is the trusted one", async (t) => {
  const login = `<!doctype html><label>Password <input type="password"></label>`;
  const scripts = { "/login": htmlPage(login) };
  const sameOrigin = `<!doctype html><title>Sign in</title><p>Sign in</p><iframe src="/login" style="width: 500px; height: 200px"></iframe>`;
  const crossOrigin = `<!doctype html><title>Sign in</title><p>Sign in</p>${crossOriginFrame("/login")}`;
  // The trusted origin is the top page's; the fill must follow the frame's origin, not the page's.
  const trustTopOrigin = { navigateOptions: (origin) => ({ password: { value: "correct-horse-battery", origin } }) };
  const refused = await runMenuScenario(t, crossOrigin, ["configured password"], scripts, trustTopOrigin);
  assert.match(refused.result.steps[0].action_error ?? "", /^origin_mismatch: refused to fill on http:\/\/localhost:\d+/);
  assert.equal(refused.result.password_filled, undefined);
  const filled = await runMenuScenario(t, sameOrigin, ["configured password"], scripts, trustTopOrigin);
  assert.equal(filled.result.password_filled, true);
});

test("resolvePrivateTransport: other providers are left as they are", () => {
  const transport = resolvePrivateTransport({ JEV_PROVIDER: "typesafe", TYPESAFE_API_KEY: "ts_test" });
  assert.equal(transport.name, "typesafe");
});

test("resolveBrowserExecutable: JEV_BROWSER_EXECUTABLE_PATH wins", () => {
  const env = { JEV_BROWSER_EXECUTABLE_PATH: " /opt/chrome/chrome " };
  assert.equal(resolveBrowserExecutable(env, () => true), "/opt/chrome/chrome");
});

test("resolveBrowserExecutable: defaults to Helium when it is installed", () => {
  assert.equal(resolveBrowserExecutable({}, (path) => path === HELIUM_EXECUTABLE_PATH), HELIUM_EXECUTABLE_PATH);
});

test("resolveBrowserExecutable: falls back to Playwright's own browser when Helium is absent", () => {
  assert.equal(resolveBrowserExecutable({}, () => false), undefined);
  assert.equal(resolveBrowserExecutable({ JEV_BROWSER_EXECUTABLE_PATH: "  " }, () => false), undefined);
});

const el = (over = {}) => ({
  attr: "j1",
  tag: "a",
  role: "link",
  text: "Espresso",
  href: "https://en.wikipedia.org/wiki/Espresso",
  typeAttr: "",
  clickable: true,
  typeable: false,
  ...over,
});

test("noise names are filtered", () => {
  assert.equal(isNoiseName("Jump up"), true);
  assert.equal(isNoiseName("[23]"), true);
  assert.equal(isNoiseName(""), true);
  assert.equal(isNoiseName("Espresso"), false);
});

test("noise hrefs are filtered, buttons without hrefs survive", () => {
  assert.equal(isNoiseHref("#cite-1"), true);
  assert.equal(isNoiseHref("javascript:void(0)"), true);
  assert.equal(isNoiseHref("mailto:x@y.z"), true);
  assert.equal(isNoiseHref("https://example.com"), false);
  assert.equal(isNoiseHref(""), false);
});

test("buildActionSpace dedupes hrefs, assigns kinds, caps size", () => {
  const raw = [
    el(),
    el({ attr: "j2", text: "Espresso again", href: "https://en.wikipedia.org/wiki/Espresso#section" }),
    el({ attr: "j3", tag: "input", role: "textbox", text: "Search", href: "", clickable: false, typeable: true, typeAttr: "text" }),
    el({ attr: "j4", tag: "select", role: "select", text: "Cabin", href: "", clickable: false, typeable: false, selectable: true, options: [{ i: 0, label: "Economy" }, { i: 1, label: "Business" }] }),
    el({ attr: "j5", tag: "input", role: "textbox", text: "pw", href: "", typeable: true, typeAttr: "password" }),
  ];
  const { elements, truncated } = buildActionSpace(raw);
  // dedupe drops j2 (same destination), password input never offered, select survives;
  // a text field with no enterSubmittable flag offers type only
  assert.deepEqual(
    elements.map((e) => `${e.kind}_${e.id}`),
    ["click_e1", "type_e2", "select_e3"],
  );
  assert.equal(truncated, false);
  assert.equal(elements[2].options?.length, 2);
});

test("buildActionSpace stamps submit controls instead of click", () => {
  const raw = [
    el({ attr: "j1", tag: "button", role: "button", text: "Join", href: "", typeAttr: "submit", clickable: true, submitControl: true }),
    el({ attr: "j2", tag: "input", role: "button", text: "Go", href: "", typeAttr: "submit", clickable: true, submitControl: true }),
    el({ attr: "j3", tag: "button", role: "button", text: "Cancel", href: "", typeAttr: "button", clickable: true }),
  ];
  const { elements } = buildActionSpace(raw);
  assert.deepEqual(
    elements.map((e) => `${e.kind}_${e.id}`),
    ["submit_e1", "submit_e2", "click_e3"],
  );
  assert.equal(elements[0].submitVia, "click");
  assert.match(elements[0].description, /button "Join" \(submit the form now\)/);
  assert.equal(elements[1].submitVia, "click");
});

test("buildActionSpace offers submit alongside type on enter-submittable fields", () => {
  const raw = [
    el({ attr: "j1", tag: "input", role: "textbox", text: "Email", href: "", clickable: false, typeable: true, typeAttr: "text", enterSubmittable: true }),
    el({ attr: "j2", tag: "textarea", role: "textbox", text: "Notes", href: "", clickable: false, typeable: true, enterSubmittable: false }),
    el({ attr: "j3", tag: "input", role: "textbox", text: "First name", href: "", clickable: false, typeable: true, typeAttr: "text", enterSubmittable: true }),
  ];
  const { elements } = buildActionSpace(raw);
  assert.deepEqual(
    elements.map((e) => `${e.kind}_${e.id}`),
    ["type_e1", "submit_e2", "type_e3", "type_e4", "submit_e5"],
  );
  assert.equal(elements[1].attr, "j1"); // submit_e2 targets the same stamped element as type_e1
  assert.equal(elements[1].submitVia, "enter");
  assert.match(elements[1].description, /submit the form now/);
  assert.match(elements[0].description, /type without submitting/);
  assert.equal(elements[2].submitVia, undefined); // textareas never offer Enter submit
});

test("buildActionSpace stamps search_eN alone on structurally search-like fields", () => {
  const raw = [
    el({ attr: "j1", tag: "input", role: "textbox", text: "Search Wikipedia", href: "", clickable: false, typeable: true, typeAttr: "search", searchField: true, enterSubmittable: true }),
    el({ attr: "j2", tag: "div", role: "searchbox", text: "Search", href: "", typeable: true, searchField: true, enterSubmittable: true }),
    // a plain text input named/labeled like a search box is NOT search-like: markup only
    el({ attr: "j3", tag: "input", role: "textbox", text: "Search", href: "", clickable: false, typeable: true, typeAttr: "text", name: "q", enterSubmittable: true }),
  ];
  const { elements } = buildActionSpace(raw);
  assert.deepEqual(
    elements.map((e) => `${e.kind}_${e.id}`),
    ["search_e1", "search_e2", "type_e3", "submit_e4"],
  );
  assert.equal(elements[0].submitVia, undefined);
  assert.match(elements[0].description, /type into this search box and run the search/);
});

test("buildCriteria exposes the distinct search, type, and submit wordings", () => {
  const raw = [
    el({ attr: "j1", tag: "input", role: "textbox", text: "Search Wikipedia", href: "", clickable: false, typeable: true, typeAttr: "search", searchField: true, enterSubmittable: true }),
    el({ attr: "j2", tag: "button", role: "button", text: "Join", href: "", typeAttr: "submit", clickable: true, submitControl: true }),
    el({ attr: "j3", tag: "input", role: "textbox", text: "Email", href: "", clickable: false, typeable: true, typeAttr: "text", enterSubmittable: true }),
  ];
  const { elements } = buildActionSpace(raw);
  const criteria = buildCriteria(elements);
  assert.match(criteria["search_e1"], /type into this search box and run the search/);
  assert.match(criteria["submit_e2"], /submit the form now/);
  assert.match(criteria["type_e3"], /type without submitting/);
  assert.match(criteria["submit_e4"], /submit the form now/);
});

test("buildActionSpace caps at MAX_ELEMENTS and reports truncation", () => {
  const many = Array.from({ length: 400 }, (_, i) => el({ attr: `j${i + 1}`, text: `Link ${i}`, href: `https://x.example/${i}` }));
  const { elements, truncated } = buildActionSpace(many);
  assert.equal(elements.length, MAX_ELEMENTS);
  assert.equal(truncated, true);
});

test("buildActionSpace cap holds when fields double up as submit targets", () => {
  const many = Array.from({ length: 400 }, (_, i) =>
    el({ attr: `j${i + 1}`, tag: "input", role: "textbox", text: `Field ${i}`, href: "", clickable: false, typeable: true, typeAttr: "text", enterSubmittable: true }),
  );
  const { elements, truncated } = buildActionSpace(many);
  // every field wants two entries (type + submit); the cap still bounds the list
  assert.equal(elements.length, MAX_ELEMENTS);
  assert.equal(truncated, true);
  assert.ok(elements.some((e) => e.kind === "type") && elements.some((e) => e.kind === "submit"));
});

test("buildCriteria stays within the Choice option limit and includes controls", () => {
  const many = Array.from({ length: MAX_ELEMENTS }, (_, i) =>
    el({ attr: `j${i + 1}`, text: `Link ${i}`, href: `https://x.example/${i}` }),
  );
  const { elements } = buildActionSpace(many);
  // Worst case: a full element list plus a focused menubar's six key actions.
  const criteria = buildCriteria(elements, buildKeyActions({ role: "menubar", label: "", activeItem: "" }));
  assert.ok(Object.keys(criteria).length <= 255);
  for (const control of ["scroll_down", "scroll_up", "back", "done"]) {
    assert.ok(criteria[control], `missing control ${control}`);
  }
});

test("pickAlternate returns next-best non-excluded option", () => {
  const alternate = pickAlternate(
    { click_e1: 0.2, click_e2: 0.5, back: 0.9, done: 0.8, click_e3: 0.3 },
    new Set(["click_e2"]),
  );
  assert.equal(alternate, "click_e3"); // back and done are never chosen as alternates
  assert.equal(pickAlternate({ a: 0 }, new Set()), null);
});

test("heuristicQuery strips task boilerplate", () => {
  assert.equal(heuristicQuery("Search Wikipedia for the article about Ristretto and stop on it"), "ristretto");
});

// ── Password delivery (src/password.ts) ──────────────────────────────────────
import { mkdtemp, mkdir, writeFile, chmod, symlink, rm, stat, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseTrustedOrigin,
  makeRedactor,
  validateSecretBuffer,
  readHandoffSecret,
  readSecretFromEnv,
  assertNoPlaywrightDebug,
  PASSWORD_REDACTED,
} from "../dist/password.js";

test("parseTrustedOrigin accepts exact origins, rejects everything looser", () => {
  assert.equal(parseTrustedOrigin("https://acme.com"), "https://acme.com");
  assert.equal(parseTrustedOrigin("https://acme.com:8443"), "https://acme.com:8443");
  assert.equal(parseTrustedOrigin("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
  assert.equal(parseTrustedOrigin("http://localhost:8080"), "http://localhost:8080");
  assert.equal(parseTrustedOrigin("http://[::1]:9000"), "http://[::1]:9000");
  assert.equal(parseTrustedOrigin(null), null);
  assert.equal(parseTrustedOrigin("https://*.example.com"), null); // wildcards are not exact
  assert.equal(parseTrustedOrigin("https://%2A.example.com"), null); // percent-encoded wildcard
  assert.equal(parseTrustedOrigin("https://acme.com/login"), null); // path
  assert.equal(parseTrustedOrigin("https://acme.com?a=1"), null); // query
  assert.equal(parseTrustedOrigin("http://acme.com"), null); // http off loopback
  assert.equal(parseTrustedOrigin("https://user:pw@acme.com"), null); // credentials
  assert.equal(parseTrustedOrigin("not a url"), null);
});

test("validateSecretBuffer keeps exact bytes and rejects bad input", () => {
  assert.equal(validateSecretBuffer(Buffer.from("hunter2extra")), "hunter2extra");
  assert.equal(validateSecretBuffer(Buffer.from(" lead and trail ")), " lead and trail "); // never trimmed
  assert.throws(() => validateSecretBuffer(Buffer.alloc(0)), /empty/);
  assert.throws(() => validateSecretBuffer(Buffer.from("abc")), /shorter/);
  assert.throws(() => validateSecretBuffer(Buffer.from([0xff, 0xfe, 0xfd, 0xfc])), /UTF-8/);
  assert.throws(() => validateSecretBuffer(Buffer.concat([Buffer.from("abcdef"), Buffer.alloc(4096)])), /exceeds/);
  // CR/LF can never be filled: password inputs strip them, so an echo of the
  // stripped value would match no redaction variant.
  assert.throws(() => validateSecretBuffer(Buffer.from("abcdef\n")), /line break/);
  assert.throws(() => validateSecretBuffer(Buffer.from("abcdef\r")), /line break/);
  assert.throws(() => validateSecretBuffer(Buffer.from("abc\r\ndef")), /line break/);
  assert.throws(() => validateSecretBuffer(Buffer.from("abcdef\x01")), /control character/);
  assert.throws(() => validateSecretBuffer(Buffer.from("abcdef\x7f")), /control character/);
  assert.throws(() => validateSecretBuffer(Buffer.from("abcdef\x9f")), /control character/); // C1: YAML serializes these as \xNN escapes
  assert.throws(() => validateSecretBuffer(Buffer.from("abcd\tefgh")), /control character/);
  // A secret whose whitespace-normalized echo would fall below the safe
  // redaction length is rejected: pages echo values with collapsed
  // whitespace, and a variant that short would match ordinary words.
  assert.throws(() => validateSecretBuffer(Buffer.from("a  b")), /collapses below/);
  assert.throws(() => validateSecretBuffer(Buffer.from(" a  b ")), /collapses below/);
  assert.throws(() => validateSecretBuffer(Buffer.from("a\u200bb\u00adc")), /collapses below/); // zero-width stripped by name resolution
  assert.equal(validateSecretBuffer(Buffer.from("abcd  efgh")), "abcd  efgh"); // normalizes to 9, fine
});

test("redactor covers raw, URL-encoded, form-encoded, and HTML-entity echoes, deeply", () => {
  const secret = "p@ss&word=1";
  const { redact, redactDeep } = makeRedactor(secret);
  assert.equal(redact(`echo ${secret} done`), `echo ${PASSWORD_REDACTED} done`);
  assert.equal(redact(`url?q=${encodeURIComponent(secret)}`), `url?q=${PASSWORD_REDACTED}`);
  assert.ok(!redact(secret.replace(/&/g, "&amp;")).includes("p@ss")); // textContent serialization: only & escaped
  assert.ok(!redact(Array.from(secret, (c) => `&#${c.codePointAt(0)};`).join("")).includes("word"));
  const deep = redactDeep({ a: [secret], nested: { b: `x${secret}y` }, keep: 42 });
  assert.ok(!JSON.stringify(deep).includes(secret));
  assert.equal(deep.keep, 42);

  // application/x-www-form-urlencoded: space becomes + and more punctuation
  // is percent-escaped than encodeURIComponent does.
  const spaced = "ab cd!";
  const form = makeRedactor(spaced);
  const formEcho = new URLSearchParams({ q: spaced }).toString();
  assert.notEqual(formEcho, encodeURIComponent(spaced)); // the encodings really differ
  const formOut = form.redact(formEcho);
  assert.ok(!formOut.includes(spaced) && !formOut.includes("cd!") && formOut.includes(PASSWORD_REDACTED));

  // The partial HTML serializations real DOM APIs produce: textContent
  // escapes only & and <; attribute serialization escapes & < > " '.
  const punct = "a'b&c";
  const ent = makeRedactor(punct);
  for (const chars of ["&", "&<", '&<>"\'']) {
    const escaped = punct.replace(new RegExp(`[${chars}]`, "g"), (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
    const out = ent.redact(escaped);
    assert.ok(!out.includes(punct) && !out.includes(escaped), `variant ${chars} should be fully replaced`);
    assert.ok(out.includes(PASSWORD_REDACTED), `variant ${chars} should be replaced, not dropped`);
  }

  // Pages normalize whitespace when echoing into single-space contexts
  // (collapsed DOM text, attributes): the normalized echo must still match.
  const odd = "a  b\tc";
  const norm = makeRedactor(odd);
  const collapsed = odd.replace(/\s+/g, " ");
  assert.notEqual(collapsed, odd); // the echo really is a different string
  const normOut = norm.redact(`x${collapsed}y`);
  assert.ok(!normOut.includes(collapsed), "normalized echo is fully replaced");
  assert.ok(normOut.includes(PASSWORD_REDACTED), "normalized echo is replaced, not dropped");

  // Markdown renderers backslash-escape punctuation: an echo inside rendered
  // markdown shows the escaped form.
  const md = "a*b_c[d]";
  const mdr = makeRedactor(md);
  const mdEcho = md.replace(/([\\`*_\[\]])/g, "\\$1");
  assert.ok(!mdr.redact(`lead ${mdEcho} tail`).includes(mdEcho));
  assert.ok(mdr.redact(`lead ${mdEcho} tail`).includes(PASSWORD_REDACTED));

  // ARIA snapshots serialize names into quoted YAML: quotes and backslashes
  // are backslash-escaped inside them, single quotes are doubled when the
  // value needs single quoting, and zero-width characters are stripped from
  // accessible names before serialization.
  const quoted = 'ab"cd';
  const ar = makeRedactor(quoted);
  const ariaEcho = quoted.replace(/(["\\])/g, "\\$1");
  assert.ok(!ar.redact(`- textbox "Username": ${ariaEcho}`).includes(ariaEcho));
  assert.ok(ar.redact(`- textbox "Username": ${ariaEcho}`).includes(PASSWORD_REDACTED));
  const single = "ab'cd{ef";
  const sr = makeRedactor(single);
  const singleEcho = single.replace(/'/g, "''");
  assert.ok(!sr.redact(`key: '${singleEcho}'`).includes(singleEcho));
  assert.ok(sr.redact(`key: '${singleEcho}'`).includes(PASSWORD_REDACTED));
  // Playwright composes both stages: JSON.stringify the name (escaping
  // quotes and backslashes), then YAML single-quote the assembled value
  // (doubling apostrophes). A secret through both looks like
  // ab''cd\"{ef and must match the composed variant.
  const both = `ab'cd"{ef`;
  const br = makeRedactor(both);
  const composed = both.replace(/(["\\])/g, "\\$1").replace(/'/g, "''");
  assert.notEqual(composed, both.replace(/'/g, "''")); // the stages really compose here
  assert.ok(!br.redact(`key: '${composed}'`).includes(composed));
  assert.ok(br.redact(`key: '${composed}'`).includes(PASSWORD_REDACTED));
  const zw = "ab\u200bcd\u00adef";
  const zr = makeRedactor(zw);
  const zwEcho = zw.replace(/[\u200b\u00ad]/g, "");
  assert.ok(!zr.redact(`- link ${zwEcho}`).includes(zwEcho));
  assert.ok(zr.redact(`- link ${zwEcho}`).includes(PASSWORD_REDACTED));

  // Capture windows are sized from the longest variant: every representation
  // the redactor can name must fit whole inside visible-limit + maxVariantLength.
  for (const s of [secret, spaced, punct, odd, md]) {
    const r = makeRedactor(s);
    assert.ok(r.maxVariantLength >= s.length, "raw secret is itself a variant");
    assert.ok(r.maxVariantLength >= encodeURIComponent(s).length, "URL-encoded variant length is covered");
    assert.ok(r.maxVariantLength >= [...s].map((c) => `&#${c.codePointAt(0)};`.length).reduce((a, b) => a + b, 0), "numeric entity variant length is covered");
  }
});

test("redaction never lets the secret reassemble across markers", () => {
  // A secret built from marker characters reappears inside two adjacent
  // markers: "[REDACTED][REDACTED]" contains "ED][RE". The postcondition
  // must catch it and fall back to the single-character marker.
  const adjacent = makeRedactor("ED][RE");
  const adjOut = adjacent.redact(`a${"ED][RE"}${"ED][RE"}b`);
  assert.ok(!adjOut.includes("ED][RE"), "adjacent echoes must not reassemble the secret across markers");
  assert.ok(!adjOut.includes("REDACTED"), "the fallback marker must not look like the standard one here");

  // A secret shaped like marker-suffix + following text reappears when the
  // marker lands right before text that continues it.
  const span = makeRedactor("ED]next");
  const spanOut = span.redact(`${"ED]next"}next steps`);
  assert.ok(!spanOut.includes("ED]next"), "a marker plus adjacent text must not reassemble the secret");
  assert.ok(!spanOut.includes("REDACTED"), "the fallback marker must not look like the standard one here");

  // A secret contained in the standard marker itself ("DACT" inside
  // "[REDACTED]") is the same class, one occurrence deep.
  const inner = makeRedactor("DACT");
  const innerOut = inner.redact(`x DACT y`);
  assert.ok(!innerOut.includes("DACT"));

  // Normal secrets keep the readable marker, and redaction stays idempotent.
  const normal = makeRedactor("hunter2!");
  const once = normal.redact(`pre hunter2! mid ${encodeURIComponent("hunter2!")} post`);
  assert.ok(once.includes(PASSWORD_REDACTED));
  assert.equal(normal.redact(once), once);
});

test("redactCapped keeps a partially captured echo out of the visible slice", () => {
  const secret = "sup3rs3cr3tvalu3!";
  const { redactCapped } = makeRedactor(secret);
  // Simulate a capture window: visible limit 40, echo at the start, filler,
  // then an echo the capture boundary cut mid-secret starting at position 41 —
  // inside the reach a plain redact's shrinkage (16 chars to a 10-char
  // marker) would pull into the displayed slice.
  const visible = 40;
  const captured = `${secret}${"y".repeat(25)}${secret.slice(0, 8)}`;
  const out = redactCapped(captured, visible);
  // The old redact-then-slice logic shrank the leading echo to a 10-char
  // marker and exposed the first three characters of the partial echo here;
  // assert on every prefix short enough to surface.
  for (let n = 3; n <= secret.length; n++) {
    assert.ok(!out.includes(secret.slice(0, n)), `partial-echo prefix of length ${n} must not surface`);
  }
  assert.ok(out.includes(PASSWORD_REDACTED), "the fully captured echo collapses to the display marker");
  assert.ok(out.length <= visible);

  // Echoes that fit inside the visible window are replaced, not preserved.
  const out2 = redactCapped(`head ${secret} tail`, 80);
  assert.ok(!out2.includes(secret) && out2.includes(PASSWORD_REDACTED));

  // The collapsed marker is held to the same postcondition: the pathological
  // marker-spanning secret must not reappear after collapse either.
  const { redactCapped: capped } = makeRedactor("ED]next");
  const out3 = capped(`${"ED]next"}next steps`, 60);
  assert.ok(!out3.includes("ED]next"));
});

test("redactCapped placeholder hygiene: native collisions, exhaustion, cap", () => {
  // A placeholder character occurring natively in page text must not be
  // collapsed to the display marker: it would misreport page content as
  // redacted.
  const native = makeRedactor("hunter2");
  assert.equal(native.redactCapped("A\u2588B", 80), "A\u2588B");

  // A secret containing every short-form candidate character still redacts:
  // the placeholder is synthesized from the private-use range.
  const hostile = "\u2588\uE000\uE001\uE002\uE003!";
  const hr = makeRedactor(hostile);
  const hOut = hr.redact(`echo ${hostile} end`);
  assert.ok(!hOut.includes(hostile) && hOut.includes(PASSWORD_REDACTED));

  // An input containing every candidate character (the full private-use
  // range) must also redact: the span-mask path never searches for a
  // character absent from the input, so nothing is exhaustible.
  const greedy = makeRedactor("hunter2!");
  let all = "\u2588";
  for (let cp = 0xe000; cp <= 0xf8ff; cp++) all += String.fromCharCode(cp);
  const gOut = greedy.redactCapped(`pre hunter2! ${all} hunter2! post`, 7000);
  assert.ok(!gOut.includes("hunter2!"));
  assert.ok(gOut.includes(PASSWORD_REDACTED));

  // Replacing a 4-character span with the 10-char marker can exceed the
  // visible cap; the drop render keeps the length promise.
  const short4 = makeRedactor("abcd");
  const out = short4.redactCapped("x abcd", 6);
  assert.ok(!out.includes("abcd"));
  assert.ok(out.length <= 6);

  // Overlapping occurrences of a self-repeating secret must all be covered:
  // "aaaa" in "baaaaa" has occurrences at both offsets, and non-overlapping
  // marking would leave the trailing "a" of the second occurrence displayed.
  const ov = makeRedactor("aaaa");
  assert.equal(ov.redactCapped("baaaaa z", 20), "b[REDACTED] z");
});

test("buildActionSpace offers fill_password only when a password source is active", () => {
  const raw = [
    el({ attr: "j1", tag: "input", role: "textbox", text: "Username", href: "", clickable: false, typeable: true, typeAttr: "text" }),
    el({ attr: "j2", tag: "input", role: "textbox", text: "Password", href: "", clickable: false, typeable: false, typeAttr: "password", passwordInput: true }),
  ];
  const off = buildActionSpace(raw);
  assert.deepEqual(off.elements.map((e) => `${e.kind}_${e.id}`), ["type_e1"]);
  const on = buildActionSpace(raw, { passwordActive: true });
  assert.deepEqual(on.elements.map((e) => `${e.kind}_${e.id}`), ["type_e1", "fill_password_e2"]);
  assert.match(on.elements[1].description, /"Password"/);
  // A nameless password field is still offered, with a generic label.
  const nameless = buildActionSpace(
    [el({ attr: "j3", tag: "input", role: "textbox", text: "", href: "", clickable: false, typeable: false, typeAttr: "password", passwordInput: true })],
    { passwordActive: true },
  );
  assert.match(nameless.elements[0].description, /"password"/);
});

test("readHandoffSecret consumes a valid one-shot file and deletes it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-handoff-"));
  await chmod(dir, 0o700);
  const file = join(dir, "pw.1");
  await writeFile(file, "super-secret-value", { mode: 0o600 });
  const buf = await readHandoffSecret(file, dir);
  assert.equal(buf.toString(), "super-secret-value");
  await assert.rejects(() => stat(file), /ENOENT/); // unlinked after read
  await rm(dir, { recursive: true, force: true });
});

test("readHandoffSecret rejects the attack shapes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-handoff-"));
  await chmod(dir, 0o700);
  const good = join(dir, "good");
  await writeFile(good, "super-secret-value", { mode: 0o600 });

  await assert.rejects(() => readHandoffSecret("relative/path", dir), /absolute/);
  await assert.rejects(() => readHandoffSecret("/etc/passwd", dir), /inside the handoff directory/);
  await assert.rejects(() => readHandoffSecret(dir, dir), /inside the handoff directory/); // the dir itself
  const subdir = join(dir, "subdir");
  await mkdir(subdir, { mode: 0o700 });
  await assert.rejects(() => readHandoffSecret(subdir, dir), /regular file/); // a directory, not a file

  // Nested paths are refused outright: an intermediate symlink directory
  // could otherwise redirect a basename-only rule anywhere on disk.
  const nestedFile = join(subdir, "pw");
  await writeFile(nestedFile, "super-secret-value", { mode: 0o600 });
  await assert.rejects(() => readHandoffSecret(nestedFile, dir), /directly inside/);

  // A handoff directory that is itself a symlink to a valid-looking directory.
  // The anchor is the symlink, so the basename-only containment rule passes
  // and only the realpath check in ensureHandoffDir can catch it.
  const realDir = await mkdtemp(join(tmpdir(), "jev-real-"));
  await chmod(realDir, 0o700);
  const realFile = join(realDir, "pw");
  await writeFile(realFile, "super-secret-value", { mode: 0o600 });
  const linkedDir = join(dir, "linkeddir");
  await symlink(realDir, linkedDir);
  await assert.rejects(() => readHandoffSecret(join(linkedDir, "pw"), linkedDir), /not a directory|symlink-free/);
  await rm(realDir, { recursive: true, force: true });

  const linked = join(dir, "linked");
  await symlink(good, linked);
  await assert.rejects(() => readHandoffSecret(linked, dir), /symlink|ELOOP|no such/i);

  const loose = join(dir, "loose");
  await writeFile(loose, "super-secret-value", { mode: 0o644 });
  await assert.rejects(() => readHandoffSecret(loose, dir), /0600/);
  await assert.rejects(() => stat(loose), /ENOENT/); // one-shot: consumed even on rejection

  const hardlinked = join(dir, "hard");
  const hardSource = join(dir, "hardsrc");
  await writeFile(hardSource, "super-secret-value", { mode: 0o600 });
  await link(hardSource, hardlinked);
  await assert.rejects(() => readHandoffSecret(hardlinked, dir), /hard links/);

  const empty = join(dir, "empty");
  await writeFile(empty, "", { mode: 0o600 });
  await assert.rejects(() => readHandoffSecret(empty, dir), /empty/);

  const big = join(dir, "big");
  await writeFile(big, "x".repeat(5000), { mode: 0o600 });
  await assert.rejects(() => readHandoffSecret(big, dir), /exceeds/);

  await rm(dir, { recursive: true, force: true });
});

test("validateSecretBuffer counts code points, not UTF-16 units", () => {
  assert.throws(() => validateSecretBuffer(Buffer.from("🐟🐟")), /shorter/); // 2 code points, 4 UTF-16 units
  assert.equal(validateSecretBuffer(Buffer.from("🐟🐟xy")), "🐟🐟xy"); // 4 code points, passes
});

test("readSecretFromEnv enforces the JEV_PASSWORD_ prefix before lookup", () => {
  process.env.JEV_PASSWORD_UNITTEST = "env-carried-secret";
  assert.equal(readSecretFromEnv("JEV_PASSWORD_UNITTEST").toString(), "env-carried-secret");
  assert.throws(() => readSecretFromEnv("TYPESAFE_API_KEY"), /JEV_PASSWORD_/);
  assert.throws(() => readSecretFromEnv("OPENAI_API_KEY"), /JEV_PASSWORD_/);
  assert.throws(() => readSecretFromEnv("JEV_PASSWORD_MISSING"), /not set/);
  assert.throws(() => validateSecretBuffer(readSecretFromEnv("JEV_PASSWORD_UNITTEST").subarray(0, 0)), /empty/);
  delete process.env.JEV_PASSWORD_UNITTEST;
});

test("redactor survives secrets that collide with the redaction marker", () => {
  for (const secret of ["[REDACTED]", "REDACTED", "DACT", "ED]he"]) {
    const { redact } = makeRedactor(secret);
    for (const echo of [`x${secret}y`, encodeURIComponent(secret), `a ${secret} b ${secret} c`]) {
      const out = redact(echo);
      assert.ok(!out.includes(secret), `secret ${JSON.stringify(secret)} survived redaction of ${JSON.stringify(echo)}`);
      assert.equal(redact(out), out, "redaction must be stable on its own output");
    }
  }
});

test("redactor covers lowercase percent-encoding of form echoes", () => {
  const secret = "ab cd?";
  const { redact } = makeRedactor(secret);
  const out = redact("ab+cd%3f"); // some servers and proxies lowercase the hex
  assert.ok(!out.includes("cd%3f") && !out.includes(secret));
});

test("assertNoPlaywrightDebug refuses debug modes that log filled values", () => {
  const saved = { PWDEBUG: process.env.PWDEBUG, DEBUG: process.env.DEBUG, DEBUG_FILE: process.env.DEBUG_FILE };
  try {
    process.env.PWDEBUG = "1";
    assert.throws(() => assertNoPlaywrightDebug(), /PWDEBUG/);
    process.env.PWDEBUG = "0";
    assert.throws(() => assertNoPlaywrightDebug(), /PWDEBUG/); // unset, do not zero
    delete process.env.PWDEBUG;

    // Wildcards and mixed specs include Playwright's namespaces, so any
    // nonempty DEBUG is refused: exact deny-lists are unreliable here.
    for (const spec of ["pw:api", "app,pw:channel", "*", "pw:*", "app pw:api", "app,pw:something-else"]) {
      process.env.DEBUG = spec;
      assert.throws(() => assertNoPlaywrightDebug(), /DEBUG/, spec);
    }
    process.env.DEBUG = "";
    assertNoPlaywrightDebug(); // explicitly empty is fine
    delete process.env.DEBUG;

    process.env.DEBUG_FILE = "/tmp/pw-debug.log";
    assert.throws(() => assertNoPlaywrightDebug(), /DEBUG_FILE/);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("navigate reuses an injected Playwright page and leaves its lifecycle to the caller", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ executablePath: resolveBrowserExecutable(process.env, existsSync) });
  } catch (error) {
    if (String(error).includes("Executable doesn't exist")) {
      t.skip("Playwright browser binary is not installed");
      return;
    }
    throw error;
  }
  const context = await browser.newContext();
  context.setDefaultTimeout(250);
  const page = await context.newPage();
  page.setDefaultTimeout(1_234);
  await page.setContent("<title>Existing session</title><main>Session content</main>");

  try {
    const result = await navigate({
      task: "Read the page",
      page,
      maxSeconds: 0,
      screenshot: "none",
    });

    assert.equal(result.status, "timeout");
    assert.equal(result.final_title, "Existing session");
    assert.match(result.page?.content ?? "", /Session content/);
    assert.equal(page.isClosed(), false);

    // Playwright exposes no default-timeout getter, so preservation is
    // asserted behaviorally: an auto-waiting op with no explicit timeout must
    // reject under the caller's defaults (1_234ms page, 250ms context), far
    // below the 8s that owned contexts get. Generous margins; timing only.
    const tPage = Date.now();
    await assert.rejects(() => page.waitForSelector("#jev-timeout-probe-page"));
    assert.ok(Date.now() - tPage < 4_000, "page default timeout was not preserved");
    const probe = await context.newPage();
    try {
      const tContext = Date.now();
      await assert.rejects(() => probe.waitForSelector("#jev-timeout-probe-context"));
      assert.ok(Date.now() - tContext < 4_000, "context default timeout was not preserved");
    } finally {
      await probe.close();
    }
  } finally {
    await browser.close();
  }
});

test("navigate refuses recordDir on an injected page before touching it", async () => {
  const explosive = new Proxy(
    {},
    {
      get(_t, prop) {
        throw new Error(`injected page must not be touched (read .${String(prop)})`);
      },
    },
  );
  // The guard must fire on options alone: any property access on the proxy
  // (video(), context(), url) fails the test.
  await assert.rejects(
    () => navigate({ task: "x", page: explosive, recordDir: "/tmp/jev-unused", startUrl: "https://example.com" }),
    /refused on runs with an injected page/,
  );
});

test("navigate requires startUrl when no page is supplied", async () => {
  await assert.rejects(() => navigate({ task: "x" }), /startUrl is required/);
});

test("navigate refuses credential runs on a recording injected page", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ executablePath: resolveBrowserExecutable(process.env, existsSync) });
  } catch (error) {
    if (String(error).includes("Executable doesn't exist")) {
      t.skip("Playwright browser binary is not installed");
      return;
    }
    throw error;
  }
  const dir = await mkdtemp(join(tmpdir(), "jev-rec-refusal-"));
  try {
    const context = await browser.newContext({ recordVideo: { dir } });
    const page = await context.newPage();
    await assert.rejects(
      () =>
        navigate({
          task: "x",
          page,
          startUrl: "https://example.com",
          password: { value: "unit-secret-value", origin: "https://example.com" },
        }),
      /injected page that is being recorded/,
    );
    assert.equal(page.isClosed(), false);
    await context.close(); // stops the recording
  } finally {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("injected credential pages suppress the screenshot even before any fill", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ executablePath: resolveBrowserExecutable(process.env, existsSync) });
  } catch (error) {
    if (String(error).includes("Executable doesn't exist")) {
      t.skip("Playwright browser binary is not installed");
      return;
    }
    throw error;
  }
  const context = await browser.newContext();
  const page = await context.newPage();
  // The page ALREADY shows the value the way a logged-in session or a
  // caller-typed field would: no fill ever happens in this run, and the
  // final screenshot must still be suppressed, because JPEG bytes cannot
  // be redacted.
  await page.setContent(
    "<title>Logged in</title><main>welcome back, unit-visible-secret-value</main>",
  );
  try {
    const result = await navigate({
      task: "Read the page",
      page,
      maxSeconds: 0,
      password: { value: "unit-visible-secret-value", origin: "https://example.com" },
    });
    assert.equal(result.status, "timeout");
    assert.equal(result.screenshot_base64_jpeg, null, "screenshot bytes must be suppressed on injected credential pages");
    assert.equal(result.screenshot_suppressed, "credential-fill");
    assert.equal(result.password_filled, undefined);
    assert.equal(page.isClosed(), false);
  } finally {
    await browser.close();
  }
});

// ── Typing selection and degradation records (src/lib.ts) ────────────────────
import {
  classifyTypingFailure,
  resolveTypingSelection,
  summarizeTypingError,
  TYPING_WARNING_MESSAGE_MAX,
  typingWarning,
} from "../dist/lib.js";

test("resolveTypingSelection auto-detects in candidate order (a stale openai key wins)", () => {
  assert.equal(resolveTypingSelection({}), null);
  const both = resolveTypingSelection({
    OPENAI_API_KEY: "sk-openai-key-0123456789",
    OPENROUTER_API_KEY: "sk-or-v1-openrouter-key-0123456789",
  });
  assert.equal(both.provider, "openai"); // openai is first in detection order
  assert.equal(both.modelId, "gpt-5.6-luna");
  const or = resolveTypingSelection({ OPENROUTER_API_KEY: "sk-or-v1-openrouter-key-0123456789" });
  assert.equal(or.provider, "openrouter");
  assert.equal(or.modelId, "deepseek/deepseek-v4.1-flash"); // code default, not the stale README one
  const google = resolveTypingSelection({ GEMINI_API_KEY: "AIza-google-key-0123456789" });
  assert.equal(google.provider, "google");
  assert.equal(google.modelId, "gemini-2.5-flash");
  // malformed or too-short keys never auto-detect
  assert.equal(resolveTypingSelection({ OPENAI_API_KEY: "sk-short" }), null);
  assert.equal(resolveTypingSelection({ OPENROUTER_API_KEY: "not-an-or-key-01234567890" }), null);
  // the model override passes through unchanged
  assert.equal(
    resolveTypingSelection({ OPENAI_API_KEY: "sk-openai-key-0123456789", JEV_BROWSER_TYPE_MODEL: "anthropic/claude-haiku-4.5" }).modelId,
    "anthropic/claude-haiku-4.5",
  );
});

test("resolveTypingSelection: BASE_URL selects a compatible endpoint; TYPE_PROVIDER runs through it", () => {
  const custom = resolveTypingSelection({ JEV_BROWSER_TYPE_BASE_URL: "http://localhost:11434/v1", JEV_BROWSER_TYPE_MODEL: "qwen2.5:7b" });
  assert.deepEqual(custom, { provider: "compatible-endpoint", modelId: "qwen2.5:7b", baseUrl: "http://localhost:11434/v1" });
  const layered = resolveTypingSelection({
    JEV_BROWSER_TYPE_PROVIDER: "openrouter",
    OPENROUTER_API_KEY: "sk-or-v1-openrouter-key-0123456789",
    JEV_BROWSER_TYPE_BASE_URL: "http://127.0.0.1:1",
  });
  assert.equal(layered.provider, "openrouter");
  assert.equal(layered.modelId, "deepseek/deepseek-v4.1-flash");
  assert.equal(layered.baseUrl, "http://127.0.0.1:1");
  // BASE_URL must at least be a valid absolute http(s) URL
  assert.throws(() => resolveTypingSelection({ JEV_BROWSER_TYPE_BASE_URL: "not a url" }), /JEV_BROWSER_TYPE_BASE_URL/);
  assert.throws(() => resolveTypingSelection({ JEV_BROWSER_TYPE_BASE_URL: "ftp://x/y" }), /http/);
});

test("resolveTypingSelection: JEV_BROWSER_TYPE_PROVIDER selects only that provider, or throws", () => {
  const forced = resolveTypingSelection({
    JEV_BROWSER_TYPE_PROVIDER: "openai",
    OPENAI_API_KEY: "sk-openai-key-0123456789",
    OPENROUTER_API_KEY: "sk-or-v1-openrouter-key-0123456789",
  });
  assert.equal(forced.provider, "openai");
  // unknown value
  assert.throws(
    () => resolveTypingSelection({ JEV_BROWSER_TYPE_PROVIDER: "bogus" }),
    /JEV_BROWSER_TYPE_PROVIDER "bogus".*openai, openrouter, anthropic, google/,
  );
  // missing key for the selected provider
  assert.throws(() => resolveTypingSelection({ JEV_BROWSER_TYPE_PROVIDER: "anthropic" }), /ANTHROPIC_API_KEY.*sk-ant-/);
  // malformed key for the selected provider, even when another provider is fine
  assert.throws(
    () => resolveTypingSelection({ JEV_BROWSER_TYPE_PROVIDER: "openai", OPENAI_API_KEY: "sk-short", OPENROUTER_API_KEY: "sk-or-v1-openrouter-key-0123456789" }),
    /OPENAI_API_KEY.*no other typing provider/,
  );
  // shape-valid length but wrong shape for the selected provider
  assert.throws(
    () => resolveTypingSelection({ JEV_BROWSER_TYPE_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "AIza-not-an-anthropic-key-012345" }),
    /sk-ant-/,
  );
  // google accepts either env var name
  const gemini = resolveTypingSelection({ JEV_BROWSER_TYPE_PROVIDER: "google", GEMINI_API_KEY: "AIza-google-key-0123456789" });
  assert.equal(gemini.provider, "google");
});

test("typingWarning shape: exact keys, optional fields absent, message capped", () => {
  const minimal = typingWarning("typing_generator_error", 3, {
    message: "x".repeat(500),
    provider: "openrouter",
    model: "google/gemini-2.5-flash-lite",
  });
  assert.deepEqual(Object.keys(minimal), ["code", "step", "message", "provider", "model"]);
  assert.equal(minimal.message.length, TYPING_WARNING_MESSAGE_MAX);
  assert.equal(TYPING_WARNING_MESSAGE_MAX, 200);
  const full = typingWarning("typing_generator_empty", 2, {
    message: "m",
    provider: "openai",
    model: "gpt-5.6-luna",
    finishReason: "length",
    fallback: "keyword-heuristic",
  });
  assert.deepEqual(Object.keys(full), ["code", "step", "message", "provider", "model", "finish_reason", "fallback"]);
  assert.equal(full.finish_reason, "length");
  assert.equal(full.fallback, "keyword-heuristic");
  const none = typingWarning("typing_fallback_no_provider", 1, { message: "m", provider: null, model: null });
  assert.equal(none.provider, null);
  assert.equal(none.model, null);
  assert.ok(!("finish_reason" in none) && !("fallback" in none));
});

test("summarizeTypingError: short, no response bodies, status carried", () => {
  const out = summarizeTypingError({
    name: "AI_APICallError",
    statusCode: 401,
    message: '401 Unauthorized: {"error":{"message":"Invalid API key sk-or-abc","code":401}}',
  });
  assert.match(out, /AI_APICallError \(HTTP 401\)/);
  assert.ok(!out.includes("Invalid API key"), "provider error body text must not survive summarization");
  assert.ok(!out.includes("{"));
  const withBodySection = summarizeTypingError(new Error("POST failed. ResponseBody: first line\nsecond line with internals"));
  assert.ok(!withBodySection.includes("internals"));
  assert.ok(!withBodySection.includes("ResponseBody"));
  const long = summarizeTypingError(new Error("E".repeat(1000)));
  assert.ok(long.length <= TYPING_WARNING_MESSAGE_MAX);
  const network = summarizeTypingError(Object.assign(new Error("Cannot connect to API: connect ECONNREFUSED 127.0.0.1:1"), { name: "AI_APICallError" }));
  assert.match(network, /ECONNREFUSED/);
});

test("classifyTypingFailure separates provider failures from local configuration errors", () => {
  assert.equal(
    classifyTypingFailure(Object.assign(new Error("Cannot connect to API: connect ECONNREFUSED 127.0.0.1:1"), { name: "AI_APICallError" })),
    "typing_generator_error",
  );
  const fetchFailed = new TypeError("fetch failed");
  fetchFailed.cause = new Error("connect ECONNREFUSED 127.0.0.1:1");
  assert.equal(classifyTypingFailure(fetchFailed), "typing_generator_error");
  // retried provider failures are wrapped by the SDK in AI_RetryError
  assert.equal(
    classifyTypingFailure(Object.assign(new Error("Failed after 3 attempts. Last error: AI_APICallError: 500 Internal Server Error"), { name: "AI_RetryError" })),
    "typing_generator_error",
  );
  assert.equal(classifyTypingFailure(new TypeError("Failed to parse URL from http://[")), "typing_configuration_error");
  assert.equal(classifyTypingFailure(Object.assign(new Error("Invalid provider options"), { name: "AI_TypeValidationError" })), "typing_configuration_error");
});

// ── Typing generator execution (dist/navigate.js, network patched out) ───────
import { createTypingGenerator, generateTextToType } from "../dist/navigate.js";

function chatCompletion(content, finishReason = "stop") {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 0,
      model: "test",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("generateTextToType: openrouter requests disabled reasoning and the raised budget", async () => {
  const realFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), body: JSON.parse(init.body) };
    return chatCompletion("ristretto");
  };
  try {
    const generator = createTypingGenerator({ OPENROUTER_API_KEY: "sk-or-v1-openrouter-key-0123456789" });
    assert.equal(generator.provider, "openrouter");
    assert.equal(generator.modelId, "deepseek/deepseek-v4.1-flash");
    const out = await generateTextToType(new AbortController().signal, generator, "task", "the search box", "https://x.test/");
    assert.deepEqual(out, { ok: true, text: "ristretto", via: "openrouter" });
    assert.match(seen.url, /openrouter\.ai\/api\/v1\/chat\/completions/);
    assert.deepEqual(seen.body.reasoning, { enabled: false }); // the body-level guard against empty reasoning output
    assert.equal(seen.body.max_tokens, 256);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("generateTextToType: other providers keep the tight cap and send no reasoning flag", async () => {
  const realFetch = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return chatCompletion('"quoted"');
  };
  try {
    // chat-completions round trip via the compatible endpoint (the openai
    // provider speaks the Responses API, whose response shape this fake does
    // not model; its request body is asserted separately below)
    const generator = createTypingGenerator({ JEV_BROWSER_TYPE_BASE_URL: "http://typing.test/v1", JEV_BROWSER_TYPE_MODEL: "local-model" });
    const out = await generateTextToType(new AbortController().signal, generator, "task", "the field", "https://x.test/");
    assert.deepEqual(out, { ok: true, text: "quoted", via: "compatible-endpoint" }); // surrounding quotes are stripped
    assert.equal(body.model, "local-model");
    assert.equal(body.reasoning, undefined); // the openrouter namespace is meaningless here
    assert.equal(body.max_tokens, 48);

    // openai path: request-only assertions
    const openai = createTypingGenerator({ OPENAI_API_KEY: "sk-openai-key-0123456789" });
    await generateTextToType(new AbortController().signal, openai, "task", "the field", "https://x.test/").catch(() => {});
    assert.equal(body.reasoning, undefined);
    assert.equal(body.max_output_tokens, 48); // Responses API parameter name
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("generateTextToType: empty generations and API failures come back as typed codes", async () => {
  const realFetch = globalThis.fetch;
  const generator = createTypingGenerator({ OPENROUTER_API_KEY: "sk-or-v1-openrouter-key-0123456789" });
  try {
    globalThis.fetch = async () => chatCompletion("", "length");
    let out = await generateTextToType(new AbortController().signal, generator, "task", "the field", "https://x.test/");
    assert.equal(out.ok, false);
    assert.equal(out.code, "typing_generator_empty");
    assert.equal(out.finishReason, "length");
    assert.match(out.message, /finish reason: length/);

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { message: "no such model", code: 404 } }), { status: 404, headers: { "content-type": "application/json" } });
    out = await generateTextToType(new AbortController().signal, generator, "task", "the field", "https://x.test/");
    assert.equal(out.ok, false);
    assert.equal(out.code, "typing_generator_error");
    assert.ok(out.message.length <= TYPING_WARNING_MESSAGE_MAX);
    assert.ok(!out.message.includes("{"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("generateTextToType: deadline aborts propagate instead of degrading", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => chatCompletion("never");
  try {
    const generator = createTypingGenerator({ OPENAI_API_KEY: "sk-openai-key-0123456789" });
    const controller = new AbortController();
    controller.abort(new Error("deadline-exceeded"));
    await assert.rejects(() => generateTextToType(controller.signal, generator, "task", "the field", "https://x.test/"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("generateTextToType: BASE_URL routes every named provider to the configured endpoint", async () => {
  const realFetch = globalThis.fetch;
  const seenUrls = [];
  globalThis.fetch = async (url) => {
    seenUrls.push(String(url));
    return chatCompletion("x");
  };
  try {
    const cases = [
      ["openai", { OPENAI_API_KEY: "sk-openai-key-0123456789" }],
      ["anthropic", { ANTHROPIC_API_KEY: "sk-ant-anthropic-key-0123456789" }],
      ["google", { GEMINI_API_KEY: "AIza-google-key-0123456789" }],
    ];
    for (const [provider, key] of cases) {
      const generator = createTypingGenerator({
        JEV_BROWSER_TYPE_PROVIDER: provider,
        JEV_BROWSER_TYPE_BASE_URL: "http://proxy.internal/api",
        ...key,
      });
      assert.equal(generator.provider, provider);
      await generateTextToType(new AbortController().signal, generator, "task", "the field", "https://x.test/").catch(() => {});
      assert.ok(
        seenUrls.some((u) => u.startsWith("http://proxy.internal/api")),
        `${provider} did not use the configured base URL (seen: ${seenUrls.join(", ")})`,
      );
      seenUrls.length = 0;
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("generateTextToType: google switches thinking off and raises the cap", async () => {
  const realFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), body: JSON.parse(init.body) };
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: "ristretto" }] }, finishReason: "STOP" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const generator = createTypingGenerator({ GEMINI_API_KEY: "AIza-google-key-0123456789" });
    assert.equal(generator.provider, "google");
    const out = await generateTextToType(new AbortController().signal, generator, "task", "the search box", "https://x.test/");
    assert.deepEqual(out, { ok: true, text: "ristretto", via: "google" });
    assert.match(seen.url, /generativelanguage\.googleapis\.com/);
    // Gemini thinks by default and can spend a 48-token cap on hidden thoughts,
    // returning nothing: thinking is switched off (budget 0 on 2.5) and the
    // cap raised, via generationConfig.thinkingConfig. The openrouter
    // reasoning namespace must not leak into any google request.
    assert.equal(seen.body.generationConfig.maxOutputTokens, 256);
    assert.deepEqual(seen.body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
    assert.equal(seen.body.generationConfig.reasoning, undefined);
    assert.equal(seen.body.reasoning, undefined);

    // Gemini 3 cannot disable thinking; "none" maps to its minimum level
    const gemini3 = createTypingGenerator({ GEMINI_API_KEY: "AIza-google-key-0123456789", JEV_BROWSER_TYPE_MODEL: "gemini-3-flash" });
    await generateTextToType(new AbortController().signal, gemini3, "task", "the search box", "https://x.test/");
    assert.deepEqual(seen.body.generationConfig.thinkingConfig, { thinkingLevel: "minimal" });

    // Only Flash families get the override: Pro models reject budget 0 (2.5)
    // and "minimal" (3.x), and pre-2.5 models have no thinking config at all.
    // They keep their default thinking and only take the raised cap.
    const cases = [
      ["gemini-2.5-flash-lite", { thinkingBudget: 0 }],
      ["gemini-2.5-pro", undefined],
      ["gemini-3.1-pro-preview", undefined],
      ["gemini-2.0-flash", undefined],
    ];
    for (const [model, thinkingConfig] of cases) {
      const g = createTypingGenerator({ GEMINI_API_KEY: "AIza-google-key-0123456789", JEV_BROWSER_TYPE_MODEL: model });
      await generateTextToType(new AbortController().signal, g, "task", "the search box", "https://x.test/");
      assert.deepEqual(seen.body.generationConfig.thinkingConfig, thinkingConfig, model);
      assert.equal(seen.body.generationConfig.maxOutputTokens, 256, model);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("createTypingGenerator: every provider builds a native spec-v4 model (no ai@7 compatibility mode)", () => {
  const cases = [
    { OPENAI_API_KEY: "sk-openai-key-0123456789" },
    { OPENROUTER_API_KEY: "sk-or-v1-openrouter-key-0123456789" },
    { JEV_BROWSER_TYPE_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-anthropic-key-0123456789" },
    { GEMINI_API_KEY: "AIza-google-key-0123456789" },
    { JEV_BROWSER_TYPE_BASE_URL: "http://typing.test/v1", JEV_BROWSER_TYPE_MODEL: "local-model" },
  ];
  const seen = new Set();
  for (const env of cases) {
    const generator = createTypingGenerator(env);
    seen.add(generator.provider);
    assert.equal(generator.model.specificationVersion, "v4", `${generator.provider} model is not spec v4`);
  }
  assert.equal(seen.size, cases.length); // each case reached a distinct provider branch
});

// ── detectBotProtection ─────────────────────────────────────────────────────
// The scoring rules: a cf-mitigated header or a known challenge title is
// decisive on its own; body markers need three to stand alone, so an article
// quoting two challenge phrases stays undetected. Block markers outrank
// challenge markers.

test("detectBotProtection: a real Cloudflare challenge page is detected as a page-evidence challenge", () => {
  const d = detectBotProtection({
    title: "Just a moment...",
    excerpt: "www.opensubtitles.com Performing security verification This website uses a security service to protect against malicious bots. Ray ID: a3f56bcf9b4e5a49 Performance and Security by Cloudflare Privacy",
  });
  assert.ok(d);
  assert.equal(d.provider, "cloudflare");
  assert.equal(d.kind, "challenge");
  assert.equal(d.from_page, true);
  assert.ok(d.evidence.some((e) => e.startsWith("title ")));
  assert.ok(d.evidence.some((e) => e === 'body "performing security verification"'));
  assert.ok(d.evidence.length <= 4);
  assert.ok(d.guidance.includes("reuse its page"));
});

test("detectBotProtection: the cf-mitigated header is decisive without page markers and is not page evidence", () => {
  const d = detectBotProtection({ title: "Welcome", excerpt: "A perfectly normal page about coffee.", cfMitigated: "challenge" });
  assert.ok(d);
  assert.equal(d.kind, "challenge");
  assert.equal(d.from_page, false);
  assert.deepEqual(d.evidence, ["header cf-mitigated: challenge"]);
});

test("detectBotProtection: cf-mitigated blocked is a block kind", () => {
  const d = detectBotProtection({ title: "Access denied", excerpt: "Nothing to see here.", cfMitigated: "BLOCKED" });
  assert.ok(d);
  assert.equal(d.kind, "block");
  assert.equal(d.from_page, false);
  assert.ok(d.guidance.includes("different network"));
});

test("detectBotProtection: a challenge title alone is decisive", () => {
  const d = detectBotProtection({ title: "Just a moment...", excerpt: "" });
  assert.ok(d);
  assert.equal(d.kind, "challenge");
  assert.equal(d.from_page, true);
});

test("detectBotProtection: body markers alone need three; one or two stay undetected", () => {
  const one = detectBotProtection({ title: "Blog", excerpt: "An article that says verify you are human once." });
  assert.equal(one, null);
  const two = detectBotProtection({
    title: "Blog",
    excerpt: "The page said verify you are human and showed Ray ID: 1234.",
  });
  assert.equal(two, null);
  const three = detectBotProtection({
    title: "Blog",
    excerpt: "It said verify you are human, showed Ray ID: 1234, and ended with Performance and Security by Cloudflare.",
  });
  assert.ok(three);
  assert.equal(three.kind, "challenge");
  assert.equal(three.from_page, true);
});

test("detectBotProtection: a hard block page is a block with page evidence", () => {
  const d = detectBotProtection({
    title: "Attention Required! | Cloudflare",
    excerpt: "Sorry, you have been blocked. Error 1020 Access denied. Ray ID: 9abc",
  });
  assert.ok(d);
  assert.equal(d.kind, "block");
  assert.equal(d.from_page, true);
  assert.ok(d.guidance.includes("cannot clear it"));
});

test("detectBotProtection: ordinary pages and empty signals stay undetected", () => {
  assert.equal(detectBotProtection({ title: "OpenSubtitles", excerpt: "Login or sign in to your account. Latest subtitles." }), null);
  assert.equal(detectBotProtection({ title: "", excerpt: "" }), null);
  assert.equal(detectBotProtection({ title: "Welcome", excerpt: "Just a moment while we load your dashboard." }), null);
});

test("detectBotProtection: evidence is capped at four entries", () => {
  const d = detectBotProtection({
    title: "Please Wait... | Cloudflare",
    excerpt:
      "Performing security verification. Verify you are human. Checking if the site connection is secure. Needs to review the security of your connection. Enable JavaScript and cookies to continue. Ray ID: 1",
  });
  assert.ok(d);
  assert.ok(d.evidence.length <= 4);
});

test("detectBotProtection: the Verifying-you-are-human variant needs Cloudflare corroboration", () => {
  // The generic wording alone is not Cloudflare-specific: another service's
  // verification page must not get Cloudflare guidance.
  const bare = detectBotProtection({ title: "Verifying you are human", excerpt: "Verifying you are human. This may take a few seconds." });
  assert.equal(bare, null);
  // The real variant carries brand evidence with it, which is what lets the
  // DOM-only run probes stop on this page.
  const branded = detectBotProtection({
    title: "Verifying you are human",
    excerpt: "Verifying you are human. This may take a few seconds. Ray ID: 8ab1c2d3e4f5a6b7",
  });
  assert.ok(branded);
  assert.equal(branded.kind, "challenge");
  assert.equal(branded.from_page, true);
  assert.ok(branded.evidence.some((e) => e.startsWith("title ")));
  // The header corroborates nothing for stopping: it is last-seen state, so a
  // generic title with only a header stays annotation, never page evidence.
  const viaHeader = detectBotProtection({ title: "Verify you are human", excerpt: "Checking your connection.", cfMitigated: "challenge" });
  assert.ok(viaHeader);
  assert.equal(viaHeader.kind, "challenge");
  assert.equal(viaHeader.from_page, false);
});

test("detectBotProtection: an incidental block phrase does not flip the header's kind", () => {
  // A clean page delivered with cf-mitigated: challenge that quotes one block
  // phrase (an article, a support page): the header's kind stands, and the
  // page never becomes run-stopping evidence.
  const d = detectBotProtection({
    title: "How Cloudflare works",
    excerpt: "When a site is denied, the page says sorry, you have been blocked, and shows an error code.",
    cfMitigated: "challenge",
  });
  assert.ok(d);
  assert.equal(d.kind, "challenge", "a single incidental body phrase must not promote block");
  assert.equal(d.from_page, false);
  assert.ok(d.evidence.includes("header cf-mitigated: challenge"));
});

test("detectBotProtection: body-only detection needs a Cloudflare-brand phrase among the markers", () => {
  // Three non-brand challenge phrases: an article quoting challenge lines,
  // not an interstitial.
  const noBrand = detectBotProtection({
    title: "Blog post",
    excerpt: "The page said performing security verification, then verify you are human, and that this process is automatic.",
  });
  assert.equal(noBrand, null);
  // Same three plus one brand phrase: an interstitial.
  const withBrand = detectBotProtection({
    title: "Blog post",
    excerpt: "It said performing security verification, verify you are human, this process is automatic, and ended with Ray ID: 42.",
  });
  assert.ok(withBrand);
  assert.equal(withBrand.kind, "challenge");
});

test("detectBotProtection: overlapping block phrases count once, not twice", () => {
  // "Sorry, you have been blocked" contains "you have been blocked"; one
  // visual phrase is one marker, so this single line alone stays undetected.
  const overlap = detectBotProtection({ title: "Access denied", excerpt: "Sorry, you have been blocked" });
  assert.equal(overlap, null);
});

test("resolveCookies defaults to a host-only cookie with hardening attributes", () => {
  assert.deepEqual(resolveCookies(undefined, "https://example.com/a"), []);
  assert.deepEqual(resolveCookies([], "https://example.com/a"), []);
  // No domain supplied: dotless hostname, which Chromium stores host-only
  // (exact host, never subdomains) - the safe default for a session cookie.
  // https start URL: secure cookies. Always httpOnly and SameSite=Lax, path /.
  assert.deepEqual(
    resolveCookies([{ name: "session", value: "abc" }], "https://app.example.com:8443/start?x=1"),
    [{ name: "session", value: "abc", domain: "app.example.com", path: "/", secure: true, httpOnly: true, sameSite: "Lax" }],
  );
  // http start URL (loopback fixtures stay seedable): secure stays false
  // unless the name or sameSite forces it.
  assert.deepEqual(
    resolveCookies([{ name: "session", value: "abc" }], "http://127.0.0.1:8080/"),
    [{ name: "session", value: "abc", domain: "127.0.0.1", path: "/", secure: false, httpOnly: true, sameSite: "Lax" }],
  );
  // A caller-supplied domain passes through verbatim (only a leading dot
  // opts into subdomain matching) and explicit attributes win over defaults.
  assert.deepEqual(
    resolveCookies(
      [{ name: "pref", value: "x", domain: ".example.com", path: "/app", secure: false, httpOnly: false, sameSite: "Strict" }],
      "https://app.example.com/start",
    ),
    [{ name: "pref", value: "x", domain: ".example.com", path: "/app", secure: false, httpOnly: false, sameSite: "Strict" }],
  );
  // __Host- names: forced secure even on http loopback, host-only, path "/".
  assert.deepEqual(
    resolveCookies([{ name: "__Host-token", value: "abc" }], "http://127.0.0.1:8080/"),
    [{ name: "__Host-token", value: "abc", domain: "127.0.0.1", path: "/", secure: true, httpOnly: true, sameSite: "Lax" }],
  );
  // __Secure- names force secure too.
  assert.equal(resolveCookies([{ name: "__Secure-sid", value: "abc" }], "http://127.0.0.1/")[0].secure, true);
  // sameSite None requires Secure in real browsers; force it so the cookie
  // survives instead of being silently dropped.
  assert.equal(resolveCookies([{ name: "sid", value: "abc", sameSite: "None" }], "http://127.0.0.1/")[0].secure, true);
  // A __Host- cookie with an explicit domain or a non-root path is invalid
  // by definition (the browser would drop it); refuse it with the reason.
  assert.throws(() => resolveCookies([{ name: "__Host-token", value: "abc", domain: "example.com" }], "https://example.com/"), /__Host- cookie "__Host-token" must stay host-only/);
  assert.throws(() => resolveCookies([{ name: "__Host-token", value: "abc", path: "/app" }], "https://example.com/"), /__Host- cookie "__Host-token" requires path/);
  // Validation kept from the original PR: a name and a value are required.
  assert.throws(() => resolveCookies([{ name: "", value: "abc" }], "https://example.com"), /name and a value/);
  assert.throws(() => resolveCookies([{ name: "x" }], "https://example.com"), /name and a value/);
  // Cookie resolution needs an http(s) start URL to bind against.
  assert.throws(() => resolveCookies([{ name: "x", value: "abc" }], "not a url"), /valid start URL/);
  assert.throws(() => resolveCookies([{ name: "x", value: "abc" }], "ftp://example.com/"), /http.s. start URL/);
  // Forced security dominates an explicit false: __Host-, __Secure-, and
  // SameSite=None cookies are invalid without Secure, so it cannot be
  // stripped (the browser would drop the cookie anyway).
  assert.equal(resolveCookies([{ name: "__Host-t", value: "abc", secure: false }], "https://example.com/")[0].secure, true);
  assert.equal(resolveCookies([{ name: "__Secure-t", value: "abc", secure: false }], "http://127.0.0.1/")[0].secure, true);
  assert.equal(resolveCookies([{ name: "s", value: "abc", sameSite: "None", secure: false }], "https://example.com/")[0].secure, true);
  // An explicit false still wins for a plain name on an https start URL.
  assert.equal(resolveCookies([{ name: "s", value: "abc", secure: false }], "https://example.com/")[0].secure, false);
  // Validation errors never quote the value: they throw before the run's
  // redactor exists, so the secret must not ride out in the message.
  const SECRETISH = "supersecret-cookie-token";
  assert.throws(
    () => resolveCookies([{ name: "s", value: SECRETISH, domain: "example.com" }, { name: "__Host-t", value: "x", domain: "example.com" }], "https://example.com/"),
    (err) => !err.message.includes(SECRETISH),
  );
  assert.throws(
    () => resolveCookies([{ name: "", value: SECRETISH }], "https://example.com/"),
    (err) => !err.message.includes(SECRETISH) && /name and a value/.test(err.message),
  );
});

test("parseCookieSpec splits on the first = only", () => {
  assert.deepEqual(parseCookieSpec("session=abc"), { name: "session", value: "abc" });
  assert.deepEqual(parseCookieSpec("jwt=eyJ.a=b=="), { name: "jwt", value: "eyJ.a=b==" });
  assert.deepEqual(parseCookieSpec("empty="), { name: "empty", value: "" });
  // A bare argument may be a value pasted by mistake; the error must not
  // quote it back to stderr.
  assert.throws(() => parseCookieSpec("supersecret-cookie-token"), (err) => !err.message.includes("supersecret-cookie-token") && /name=value/.test(err.message));
  assert.throws(() => parseCookieSpec("=x"), /name=value/);
});

test("makeRedactor redacts several secrets, longest first (prefix case)", () => {
  // Two cookie values where one is a prefix of the other, plus a password:
  // every value must redact, and the shorter prefix must never survive inside
  // the longer value's match.
  const { redact, redactDeep } = makeRedactor(["s3ssion-prefix-token", "s3ssion", "hunter2!"]);
  assert.equal(redact("a s3ssion-prefix-token b"), `a ${PASSWORD_REDACTED} b`);
  assert.equal(redact("a s3ssion b"), `a ${PASSWORD_REDACTED} b`);
  assert.equal(redact("pw hunter2! ok"), `pw ${PASSWORD_REDACTED} ok`);
  // Adjacent echoes of two different secrets, and one embedded in the other.
  assert.ok(!redact("x s3ssion-prefix-token s3ssion y").includes("s3ssion"));
  assert.ok(redact("x s3ssion-prefix-token s3ssion y").includes(PASSWORD_REDACTED));
  // Encoded forms of each secret still redact.
  assert.ok(!redact(`q=${encodeURIComponent("s3ssion-prefix-token")}`).includes("s3ssion"));
  // Deep pass covers every secret across nested structures.
  const deep = redactDeep({ steps: ["s3ssion-prefix-token", { text: "s3ssion" }], url: "x?s3ssion" });
  assert.equal(JSON.stringify(deep).includes("s3ssion"), false);
  // Idempotence: redacting redacted output changes nothing.
  const once = redact("s3ssion-prefix-token and s3ssion");
  assert.equal(redact(once), once);
});

test("navigate refuses seed cookies on an injected page before touching it", async () => {
  const explosive = new Proxy(
    {},
    {
      get(_t, prop) {
        throw new Error(`injected page must not be touched (read .${String(prop)})`);
      },
    },
  );
  // The guard must fire on options alone: any property access on the proxy
  // (context(), addCookies via the context, url) fails the test.
  await assert.rejects(
    () =>
      navigate({
        task: "x",
        page: explosive,
        startUrl: "https://example.com",
        cookies: [{ name: "session", value: "unit-cookie-value" }],
      }),
    /seed cookies are refused on runs with an injected page/,
  );
});

test("navigate refuses recording on seed-cookie runs before any browser is armed", async () => {
  // No browser is launched for this call: the refusal must come from the
  // pre-timer guard region, like the injected-page recordDir refusal.
  await assert.rejects(
    () =>
      navigate({
        task: "x",
        startUrl: "https://example.com",
        recordDir: "/tmp/jev-unused",
        cookies: [{ name: "session", value: "unit-cookie-value" }],
      }),
    /video recording is refused on runs with seed cookies/,
  );
});

test("navigate refuses cookie values that could never be redacted reliably", async () => {
  // Same validation as the password value: too short, control characters, or
  // a line break would leave echoes the redactor cannot match.
  await assert.rejects(
    () => navigate({ task: "x", startUrl: "https://example.com", cookies: [{ name: "session", value: "abc" }] }),
    /cookie "session" is shorter than/,
  );
  await assert.rejects(
    () => navigate({ task: "x", startUrl: "https://example.com", cookies: [{ name: "session", value: "unit-cookie-value\u0007" }] }),
    /cookie "session" contains a control character/,
  );
  await assert.rejects(
    () => navigate({ task: "x", startUrl: "https://example.com", cookies: [{ name: "session", value: "unit-cookie-value\n" }] }),
    /cookie "session" contains a line break/,
  );
});

test("cookie runs are credential runs end to end: seeded, gated, redacted, unscreenrecorded", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ executablePath: resolveBrowserExecutable(process.env, existsSync) });
  } catch (error) {
    if (String(error).includes("Executable doesn't exist")) {
      t.skip("Playwright browser binary is not installed");
      return;
    }
    throw error;
  }
  const { createServer } = await import("node:http");
  const VALUE = "unit-cookie-secret-value";
  let documentCookie = "";
  let gatedDocuments = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const cookie = req.headers.cookie ?? "";
    res.setHeader("content-type", "text/html; charset=utf-8");
    // Only the document request is judged; Chromium's favicon probe must not
    // muddy the assertions.
    if (url.pathname === "/orders") {
      documentCookie = cookie;
      if (!cookie.split(";").some((part) => part.trim() === "session=" + VALUE)) {
        gatedDocuments += 1;
        res.statusCode = 403;
        res.end("<!doctype html><html><head><title>Forbidden</title></head><body><h1>403 sign in required</h1></body></html>");
        return;
      }
    }
    // Authenticated content echoes the value the way a hostile page would:
    // visible text plus console output, so the test proves every echo redacts.
    res.end(
      `<!doctype html><html><head><title>Orders</title></head><body><h1>Order 1</h1>` +
        `<p id="mirror">mirror: ${VALUE}</p>` +
        `<script>console.error("echo: ${VALUE}")</script>` +
        `</body></html>`,
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    // maxSeconds 0: the loop breaks at step 1 before any model call; the
    // navigation, seeding, redaction, and result assembly still run.
    const result = await navigate({
      task: "Read the newest order",
      startUrl: origin + "/orders",
      maxSeconds: 0,
      cookies: [{ name: "session", value: VALUE }],
    });
    assert.equal(result.status, "timeout");
    // The cookie actually seeded: the document 403s without it.
    assert.equal(gatedDocuments, 0, "the fixture saw the document request without the cookie");
    assert.ok(documentCookie.split(";").some((part) => part.trim() === "session=" + VALUE), "the server must receive the seeded cookie");
    // The authenticated page was reached and its echo redacted everywhere.
    assert.ok(result.page.content.includes("Order 1"), "the gated page content should be in the payload");
    assert.ok(!JSON.stringify(result).includes(VALUE), "the cookie value must not survive anywhere in the result");
    assert.ok(result.page.content.includes("mirror: [REDACTED]"), "a reflected echo must be redacted in the payload");
    const echo = (result.console_events ?? []).find((e) => e.type === "console_error");
    assert.ok(echo, "the fixture's console.error echo should be captured");
    assert.match(echo.text, /echo: \[REDACTED\]/);
    // Credential-run treatment: the final screenshot is suppressed from run
    // start (the first rendered page can already reflect the value).
    assert.equal(result.screenshot_base64_jpeg, null);
    assert.equal(result.screenshot_suppressed, "credential-fill");
  } finally {
    await browser.close();
    server.close();
  }
});

test("the judged excerpt is the open dialog, else the text on screen", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ executablePath: resolveBrowserExecutable(process.env, existsSync) });
  } catch (error) {
    if (String(error).includes("Executable doesn't exist")) {
      t.skip("Playwright browser binary is not installed");
      return;
    }
    throw error;
  }
  const { createServer } = await import("node:http");
  const header = Array.from({ length: 80 }, (_, i) => `<p>Navigation link ${i} and site banner text.</p>`).join("");
  const pages = {
    "/dialog":
      `<!doctype html><html><head><title>Account</title></head><body>${header}` +
      `<div role="dialog" aria-modal="true" style="position:fixed;top:10px;left:10px;background:#fff">` +
      `<h2>Forgot your password?</h2><p>Reset email sent.</p><button>Back to login</button></div></body></html>`,
    "/long":
      `<!doctype html><html><head><title>Long</title></head><body><p>Top of the page.</p>` +
      `<div style="height:4000px"></div><p>Far below the fold.</p></body></html>`,
  };
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(pages[req.url] ?? "");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const states = [];
  const transport = {
    name: "fixture",
    async ask({ state, questions }) {
      states.push(state);
      const answers = {};
      for (const [id, question] of Object.entries(questions)) {
        const keys = question.type === "noul" ? [] : Object.keys(question.criteria);
        answers[id] =
          question.type === "noul"
            ? { type: "noul", noul: 0 }
            : { type: "choice", choice: "done", confidence: 1, probabilities: Object.fromEntries(keys.map((key) => [key, key === "done" ? 1 : 0])) };
      }
      return { answers, usage: { input_tokens: 1, output_tokens: 1 }, model: "fixture" };
    },
  };
  try {
    const page = await browser.newPage();
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${origin}/dialog`);
    await navigate({ task: "check", page, transport, maxSteps: 1, screenshot: "none" });
    assert.equal(states[0].page_text_excerpt, "Forgot your password? Reset email sent. Back to login");
    await page.goto(`${origin}/long`);
    await navigate({ task: "check", page, transport, maxSteps: 1, screenshot: "none" });
    assert.equal(states[1].page_text_excerpt, "Top of the page.");
  } finally {
    await browser.close();
    server.close();
  }
});

test("credential runs judge the page-start excerpt so split-span secrets stay redactable", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ executablePath: resolveBrowserExecutable(process.env, existsSync) });
  } catch (error) {
    if (String(error).includes("Executable doesn't exist")) {
      t.skip("Playwright browser binary is not installed");
      return;
    }
    throw error;
  }
  const context = await browser.newContext();
  const page = await context.newPage();
  // The secret renders as two adjacent inline spans: contiguous in
  // innerText, split across a space by any per-node trimming collector.
  await page.setContent(
    "<title>Session</title><main><p>Session token: <span>tok-</span><span>abc123</span> active.</p></main>",
  );
  const states = [];
  const transport = {
    name: "fixture",
    async ask({ state, questions }) {
      states.push(state);
      const answers = {};
      for (const [id, question] of Object.entries(questions)) {
        const keys = question.type === "noul" ? [] : Object.keys(question.criteria);
        answers[id] =
          question.type === "noul"
            ? { type: "noul", noul: 0 }
            : { type: "choice", choice: "done", confidence: 1, probabilities: Object.fromEntries(keys.map((key) => [key, key === "done" ? 1 : 0])) };
      }
      return { answers, usage: { input_tokens: 1, output_tokens: 1 }, model: "fixture" };
    },
  };
  try {
    await navigate({
      task: "Read the session token status",
      page,
      transport,
      maxSteps: 1,
      screenshot: "none",
      password: { value: "tok-abc123", origin: "https://example.com" },
    });
    assert.ok(states.length >= 1, "at least one Jev call must happen");
    const excerpt = states[0].page_text_excerpt;
    assert.ok(!excerpt.includes("tok-abc123"), "the whole secret must never reach Jev");
    assert.ok(!excerpt.includes("tok- abc123"), "a space-split echo of the secret must never reach Jev");
    assert.ok(excerpt.length > 0, "the page-start excerpt is still judged on credential runs");
  } finally {
    await browser.close();
  }
});

test("only modal dialogs hijack the excerpt; a plain open dialog and an empty viewport do not", async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ executablePath: resolveBrowserExecutable(process.env, existsSync) });
  } catch (error) {
    if (String(error).includes("Executable doesn't exist")) {
      t.skip("Playwright browser binary is not installed");
      return;
    }
    throw error;
  }
  const { createServer } = await import("node:http");
  const pages = {
    "/nonmodal":
      `<!doctype html><html><head><title>Tools</title></head><body><p>Visible page content.</p>` +
      `<dialog id="d"><p>Non-modal helper text.</p></dialog><script>document.getElementById("d").show()</script></body></html>`,
    "/modal":
      `<!doctype html><html><head><title>Tools</title></head><body><p>Visible page content.</p>` +
      `<dialog id="d"><p>Modal helper text.</p></dialog><script>document.getElementById("d").showModal()</script></body></html>`,
    "/empty": `<!doctype html><html><head><title>Empty</title></head><body><div style="height:4000px"></div><p>Far below the fold.</p></body></html>`,
  };
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(pages[req.url] ?? "");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const states = [];
  const transport = {
    name: "fixture",
    async ask({ state, questions }) {
      states.push(state);
      const answers = {};
      for (const [id, question] of Object.entries(questions)) {
        const keys = question.type === "noul" ? [] : Object.keys(question.criteria);
        answers[id] =
          question.type === "noul"
            ? { type: "noul", noul: 0 }
            : { type: "choice", choice: "done", confidence: 1, probabilities: Object.fromEntries(keys.map((key) => [key, key === "done" ? 1 : 0])) };
      }
      return { answers, usage: { input_tokens: 1, output_tokens: 1 }, model: "fixture" };
    },
  };
  try {
    const page = await browser.newPage();
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${origin}/nonmodal`);
    await navigate({ task: "check", page, transport, maxSteps: 1, screenshot: "none" });
    assert.ok(states[0].page_text_excerpt.includes("Visible page content."), "a show() dialog must not hijack the excerpt");
    // The non-modal dialog renders in the viewport, so its text may appear
    // alongside the page text — but it must never replace it.
    await page.goto(`${origin}/modal`);
    await navigate({ task: "check", page, transport, maxSteps: 1, screenshot: "none" });
    assert.ok(states[1].page_text_excerpt.includes("Modal helper text."), "a showModal() dialog is the excerpt");
    await page.goto(`${origin}/empty`);
    await navigate({ task: "check", page, transport, maxSteps: 1, screenshot: "none" });
    assert.equal(states[2].page_text_excerpt, "", "no visible text means an honest empty excerpt, not the unseen body start");
  } finally {
    await browser.close();
    server.close();
  }
});
