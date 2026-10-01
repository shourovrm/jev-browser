// The navigation loop. Code owns control flow; Jev owns the judgments.
// Hardening pass applied per external review: stop gates run BEFORE action
// execution, the deadline is a real AbortSignal threaded through Jev, the
// typing generator, and every Playwright timeout, usage is per-run, and the
// final payload/screenshot extraction is best-effort.
import { chromium, type Browser, type BrowserContext, type ConsoleMessage, type ElementHandle, type Frame, type Page, type Request, type Response } from "playwright";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import TurndownService from "turndown";
import * as gfm from "turndown-plugin-gfm";
import {
  buildActionSpace,
  buildCriteria,
  buildKeyActions,
  FocusedMenu,
  MENU_KEYS,
  classifyTypingFailure,
  detectBotProtection,
  heuristicQuery,
  pickAlternate,
  PRICE_PER_MTOK_IN,
  RawElement,
  resolveBrowserExecutable,
  resolveCookies,
  resolveTypingSelection,
  SeedCookie,
  selectorFor,
  summarizeTypingError,
  BotProtection,
  TypingSelection,
  TypingWarning,
  TypingWarningCode,
  typingWarning,
} from "./lib.js";
import { selectOptionQuestion, stepQuestions } from "./questions.js";
import { assertNoPlaywrightDebug, makeRedactor, parseTrustedOrigin, validateSecretBuffer, type Redactor } from "./password.js";
import { askJev as askProvider, InvalidJevAnswer, OPENROUTER_PRIVACY_FILTER, resolvePrivateTransport, type JevTransport, type JevAnswer } from "./provider.js";

const MAX_CONSOLE_EVENTS = 200;
const STATE_EXCERPT_CHARS = 1_500;
// Display limits on credential runs: what model-facing strings may show.
// Capture windows are these plus the longest secret representation.
const CREDENTIAL_VISIBLE = { label: 80, option: 120, href: 120 };

export interface NavigateOptions {
  task: string;
  /** Start URL for an internally-created page. Omit when `page` is supplied. */
  startUrl?: string;
  /** Reuse an existing Playwright page instead of launching a new browser. */
  page?: Page;
  /** Override judgment transport for this run, independent of JEV_PROVIDER and credentials. */
  transport?: JevTransport;
  maxSteps?: number;
  maxSeconds?: number;
  allowTyping?: boolean;
  format?: "text" | "markdown" | "html" | "aria";
  maxChars?: number;
  screenshot?: "final" | "none";
  recordDir?: string;
  password?: { value: string; origin: string };
  /**
   * Seed cookies added to the run's own browser context before the first
   * navigation, so a run can start behind a login the agent cannot perform
   * itself (password fields are never typed into). Values are secrets of the
   * same rank as the password and are redacted from every state, trace,
   * error, payload, and result this function produces; recording is refused
   * and the final screenshot is suppressed from run start (the page can
   * reflect a cookie value into pixels on the very first load). Refused on
   * runs with an injected page: addCookies would mutate a caller-owned
   * context. Never source values from anything model-composed (the CLI and
   * MCP adapters take file or environment references, never values).
   */
  cookies?: SeedCookie[];
}

export interface StepRecord {
  step: number;
  t_ms?: number; // milliseconds after run start when this step began
  proposed_action: string;
  executed_action: string | null; // null when a watcher stopped the loop before execution
  detail: string;
  recovery_reason?: string;
  action_error?: string;
  outcome: string;
  confidence: number | null;
  top_probability: number | null;
  goal_done: number;
  stuck: number;
}

export interface ConsoleEvent {
  step: number;
  type: "console_error" | "console_warning" | "page_error" | "request_failed";
  text: string;
  page: string;
}

export interface JevUsage {
  jev_calls: number;
  input_tokens: number;
  output_tokens: number;
  est_cost_usd: number;
}

const DEFAULT_CAPS: Record<string, number> = {
  text: 8_000,
  markdown: 16_000,
  html: 1_000_000,
  aria: 16_000,
};

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
turndown.use(gfm.gfm);

interface RunBudget {
  usage: JevUsage;
  transport: JevTransport;
  signal: AbortSignal;
  deadlineAt: number; // performance.now() milliseconds
  // Per-run model/provider state: resolved inside navigate() and mutated only
  // by this run's askJev calls, so concurrent runs cannot report each other's
  // provider and a failed run cannot inherit values from a previous one.
  requestedModel: string;
  model: string; // model reported by the most recent Jev call
  provider: string | null;
}

async function askJev(budget: RunBudget, state: unknown, questions: Record<string, unknown>) {
  const result = await askProvider(budget.transport, { state, questions, model: budget.requestedModel, signal: budget.signal });
  budget.provider = result.provider;
  budget.model = result.model;
  budget.usage.jev_calls += 1;
  budget.usage.input_tokens += result.usage.input_tokens;
  budget.usage.output_tokens += result.usage.output_tokens;
  budget.usage.est_cost_usd = (budget.usage.input_tokens / 1e6) * PRICE_PER_MTOK_IN;
  return result.answers;
}

// ── Typing generator: provider-agnostic via the Vercel AI SDK ────────────────
export interface TypingGenerator {
  provider: string; // label reported in results and step details
  modelId: string;
  model: Parameters<typeof generateText>[0]["model"];
}

/**
 * Build the typing generator for a run. Selection logic (including the
 * strict JEV_BROWSER_TYPE_PROVIDER contract) lives in resolveTypingSelection;
 * this only wires the selected configuration to a provider client. Returns
 * null when no typing provider is configured.
 */
export function createTypingGenerator(env: NodeJS.ProcessEnv = process.env): TypingGenerator | null {
  const selection: TypingSelection | null = resolveTypingSelection(env);
  if (!selection) return null;
  switch (selection.provider) {
    case "openai":
      return {
        provider: "openai",
        modelId: selection.modelId,
        model: createOpenAI({ apiKey: env.OPENAI_API_KEY!, ...(selection.baseUrl ? { baseURL: selection.baseUrl } : {}) })(selection.modelId),
      };
    case "openrouter": {
      const provider = createOpenAICompatible({
        name: "openrouter",
        baseURL: selection.baseUrl ?? "https://openrouter.ai/api/v1",
        apiKey: env.OPENROUTER_API_KEY!,
      });
      return { provider: "openrouter", modelId: selection.modelId, model: provider(selection.modelId) };
    }
    case "anthropic":
      return {
        provider: "anthropic",
        modelId: selection.modelId,
        model: createAnthropic({ apiKey: env.ANTHROPIC_API_KEY!, ...(selection.baseUrl ? { baseURL: selection.baseUrl } : {}) })(selection.modelId),
      };
    case "google":
      return {
        provider: "google",
        modelId: selection.modelId,
        // Every @ai-sdk provider here implements model spec v4, the native
        // spec of the ai@7 core, so no compatibility cast is needed or wanted.
        model: createGoogleGenerativeAI({
          apiKey: (env.GOOGLE_GENERATIVE_AI_API_KEY ?? env.GEMINI_API_KEY)!,
          ...(selection.baseUrl ? { baseURL: selection.baseUrl } : {}),
        })(selection.modelId),
      };
    default: {
      const provider = createOpenAICompatible({
        name: "custom",
        baseURL: selection.baseUrl!,
        apiKey: env.JEV_BROWSER_TYPE_API_KEY ?? "",
      });
      return { provider: "compatible-endpoint", modelId: selection.modelId, model: provider(selection.modelId) };
    }
  }
}

// Gemini Flash families whose thinking can be switched off (2.5) or dropped to
// a minimum level (3+) through the AI SDK's reasoning: "none". Pro models
// cannot go that low and pre-2.5 models have no thinking configuration.
const GEMINI_FLASH_THINKING_OFF = /^(models\/)?gemini-(2\.5|[3-9](\.\d+)?)-flash|^(models\/)?gemini-flash(-lite)?-latest$/;

export type TypingTextResult =
  | { ok: true; text: string; via: string }
  | { ok: false; code: TypingWarningCode; message: string; finishReason?: string };

/**
 * Generate the text for one type/search action. Never falls back to the
 * keyword heuristic itself: the caller decides what a failure means (ordinary
 * fields type nothing; search fields take the heuristic) and records the
 * structured warning.
 */
export async function generateTextToType(
  signal: AbortSignal,
  generator: TypingGenerator,
  task: string,
  elementDescription: string,
  url: string,
): Promise<TypingTextResult> {
  // Reasoning models (OpenRouter's, and Gemini, which thinks by default) can
  // burn the whole budget on hidden reasoning tokens and return an empty
  // message, so reasoning is disabled there and the output budget raised;
  // other providers keep the tight cap. On Google only Gemini Flash models
  // accept the "none" mapping (budget 0 on 2.5, minimum level on 3+, which
  // still thinks a little, hence the headroom); Pro and older models reject
  // it, so they keep their default thinking and just get the larger cap.
  const generationLimits =
    generator.provider === "openrouter"
      ? { maxOutputTokens: 256, providerOptions: { openrouter: { reasoning: { enabled: false }, provider: OPENROUTER_PRIVACY_FILTER } } }
      : generator.provider === "google"
        ? { maxOutputTokens: 256, ...(GEMINI_FLASH_THINKING_OFF.test(generator.modelId) ? { reasoning: "none" as const } : {}) }
        : { maxOutputTokens: 48 };
  try {
    const { text, finishReason } = await generateText({
      model: generator.model,
      prompt: `A browser agent is performing this task: "${task}". It must type into the ${elementDescription} on ${url}. Reply with ONLY the exact text to type (for a search box: a short search query; no quotes, no explanation).`,
      ...generationLimits,
      abortSignal: signal,
    });
    const cleaned = text.trim().replace(/^["']|["']$/g, "");
    if (cleaned.length === 0) {
      return {
        ok: false,
        code: "typing_generator_empty",
        message: `typing model returned no text${finishReason ? ` (finish reason: ${finishReason})` : ""}`,
        finishReason: finishReason ?? undefined,
      };
    }
    return { ok: true, text: cleaned, via: generator.provider };
  } catch (error) {
    if (signal.aborted) throw error; // deadline/cancellation propagates
    return { ok: false, code: classifyTypingFailure(error), message: summarizeTypingError(error) };
  }
}

// ── Extraction: DOM-first (a11y trees under-report inputs) ───────────────────
export interface CaptureCaps {
  label: number;
  option: number;
  href: number;
}
// Non-credential defaults preserve the original extraction semantics exactly:
// labels capped at 80 (the noise-name threshold), hrefs and option labels
// uncapped in practice.
const DEFAULT_CAPTURE_CAPS: CaptureCaps = { label: 80, option: 1_000_000, href: 1_000_000 };

// Every scan of the page goes through a Playwright locator rather than
// document.querySelectorAll: Playwright's CSS engine also searches open shadow
// roots, nested ones included, so controls inside web components are found.
// Closed shadow roots stay out of reach, as they are for any page script.
// Menu items, list options and tabs are often plain <li> or <div> elements
// that carry only an ARIA role; without these roles an open menu or
// autocomplete list offers Jev nothing to pick.
const CANDIDATE_SELECTOR =
  'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="searchbox"], [role="textbox"], ' +
  '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="tab"], [role="combobox"]';
const NATIVE_CONTROL_SELECTOR = "a, button, input, select, textarea";
const MODAL_SELECTOR = '[aria-modal="true"], dialog:modal';

/** The innermost open modal dialog in document order, shadow roots included, or null. */
async function openModalHandle(page: Page): Promise<ElementHandle<Node> | null> {
  const modals = await page.locator(MODAL_SELECTOR).elementHandles().catch(() => []);
  const shownIndex = await page
    .evaluate(
      (candidates) =>
        (candidates as Element[]).map((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden").lastIndexOf(true),
      modals,
    )
    .catch(() => -1);
  for (const [index, modal] of modals.entries()) if (index !== shownIndex) await modal.dispose();
  return modals[shownIndex] ?? null;
}

// Frames smaller than this in either dimension are tracking pixels and ad
// slots far more often than something a task needs.
const MIN_FRAME_SIDE_PX = 50;

/**
 * The frames worth scanning this step, main frame first. Child frames are
 * skipped when they are detached, hidden (no bounding box) or smaller than
 * MIN_FRAME_SIDE_PX. about:blank frames are kept: pages such as the
 * W3Schools editor write their content into one. Cross-origin frames are
 * included: Playwright reaches them like any other frame.
 */
async function scannableFrames(page: Page): Promise<Frame[]> {
  const frames = [page.mainFrame()];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame() || frame.isDetached()) continue;
    const frameElement = await frame.frameElement().catch(() => null);
    const box = await frameElement?.boundingBox().catch(() => null);
    await frameElement?.dispose();
    if (!box || box.width < MIN_FRAME_SIDE_PX || box.height < MIN_FRAME_SIDE_PX) continue;
    frames.push(frame);
  }
  return frames;
}

/**
 * The frame's real origin. Read from the page rather than the frame URL,
 * because an about:blank or srcdoc frame inherits its parent's origin while
 * its URL has none. "null" for sandboxed frames.
 */
async function frameOrigin(frame: Frame): Promise<string | null> {
  return frame.evaluate(() => window.origin).catch(() => null);
}

/**
 * Scans the main frame and every scannable child frame, main frame first, so
 * the page's own controls come first in the shared MAX_ELEMENTS budget.
 * Returns the frames too: each element's frameIndex points into that list,
 * and actions run through the element's own frame.
 */
async function extractAndStamp(
  page: Page,
  bounded: (cap: number) => number,
  caps: CaptureCaps = DEFAULT_CAPTURE_CAPS,
  includePasswordInputs = false,
): Promise<{ raw: RawElement[]; frames: Frame[] }> {
  const frames = await scannableFrames(page);
  const pageOrigin = await frameOrigin(page.mainFrame());
  const raw: RawElement[] = [];
  for (const [frameIndex, frame] of frames.entries()) {
    const isMainFrame = frameIndex === 0;
    try {
      const frameElements = await scanFrame(frame, caps, includePasswordInputs, isMainFrame ? await openModalHandle(page) : null, isMainFrame ? "j" : `f${frameIndex}-j`);
      if (!isMainFrame) {
        const origin = await frameOrigin(frame);
        // Only a real, different origin gets a host note; a sandboxed frame's
        // "null" origin has no host to name.
        const host = origin && origin !== "null" && origin !== pageOrigin ? new URL(origin).host : undefined;
        for (const element of frameElements) {
          element.frameIndex = frameIndex;
          element.frameHost = host;
        }
      }
      raw.push(...frameElements);
    } catch (error) {
      // A child frame can detach or navigate mid-scan; its controls are just
      // missing this step. The main frame's errors keep their old meaning.
      if (isMainFrame) throw error;
    }
  }
  return { raw, frames };
}

/** Clears old stamps in one frame, then stamps and describes its candidates. */
async function scanFrame(
  frame: Frame,
  caps: CaptureCaps,
  includePasswordInputs: boolean,
  modal: ElementHandle<Node> | null,
  attrPrefix: string,
): Promise<RawElement[]> {
  // Clear stamps from previous steps first: elements that dropped out of the
  // candidate list keep their old data-jev-id, which would make selectors
  // match more than one element.
  await frame.locator("[data-jev-id]").evaluateAll((stamped) => stamped.forEach((el) => el.removeAttribute("data-jev-id")));
  try {
    return await scanCandidates(frame, caps, includePasswordInputs, modal, attrPrefix);
  } finally {
    await modal?.dispose();
  }
}

async function scanCandidates(
  frame: Frame,
  caps: CaptureCaps,
  includePasswordInputs: boolean,
  modal: ElementHandle<Node> | null,
  attrPrefix: string,
): Promise<RawElement[]> {
  return frame.locator(CANDIDATE_SELECTOR).evaluateAll(
    // The modal arrives as a live element; it is typed unknown here because
    // Playwright's handle-unboxing types recurse too deeply over Element.
    (
      candidates,
      { cap, includePw, modal: modalArgument, attrPrefix }: { cap: CaptureCaps; includePw: boolean; modal: unknown; attrPrefix: string },
    ) => {
      const modal = modalArgument as Element | null;
      // Text as rendered through <slot> elements. A web component's inner
      // control often holds only a <slot>, so its own innerText and
      // textContent are empty and the label lives in the host's light DOM.
      // assignedNodes({ flatten: true }) also returns a slot's fallback
      // content when nothing is assigned to it.
      const slottedText = (node: Node): string => {
        if (node instanceof HTMLSlotElement) return node.assignedNodes({ flatten: true }).map(slottedText).join(" ");
        if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
        return Array.from(node.childNodes).map(slottedText).join(" ");
      };
      // Walks the flat tree upward: a slotted element goes to its slot, a
      // shadow root to its host. Plain contains() stops at shadow
      // boundaries, and a component dialog's buttons are usually slotted.
      const insideModal = (el: Element): boolean => {
        for (let node: Node | null = el; node; node = (node as Element).assignedSlot ?? node.parentNode ?? (node as ShadowRoot).host ?? null) {
          if (node === modal) return true;
        }
        return false;
      };
      const out: any[] = [];
      for (const el of candidates as HTMLElement[]) {
        // Cap accepted candidates AFTER filtering so hidden boilerplate at the
        // top of the DOM cannot crowd out usable controls below it.
        if (out.length >= 2000) break;
        const rects = el.getClientRects();
        if (!rects.length) continue;
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const tag = el.tagName.toLowerCase();
        const roleAttr = el.getAttribute("role") || "";
        const typeAttr = (el.getAttribute("type") || "").toLowerCase();
        // Accessible-name resolution for form controls (AccName 1.2 §4.3.2):
        // aria-labelledby refs first, then aria-label, then the control's
        // associated native labels (label[for] and wrapping labels, all of
        // them, in tree order), then placeholder and title. Inputs are void
        // elements: innerText is always empty, so plain <label for> forms
        // resolve here or not at all. Every candidate is normalized before the
        // fallback chain so a blank attribute cannot suppress the rest of it.
        const norm = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();
        const labelledby = norm(
          (el.getAttribute("aria-labelledby") ?? "")
            .split(/\s+/)
            // Ids are scoped to their shadow root, so look the reference up
            // in the control's own root, not the document.
            .map((ref) => (el.getRootNode() as Document | ShadowRoot).getElementById(ref)?.textContent ?? "")
            .join(" "),
        );
        const nativeLabels = norm(
          Array.from((el as HTMLInputElement).labels ?? [])
            .map((l) => l.textContent ?? "")
            .join(" "),
        );
        // Search-like fields, by structure alone: input[type=search] or
        // role=searchbox. No form-membership or label-text heuristics here:
        // a plain text field that only looks like a search box is a real form
        // field and must keep type + submit, not a one-action search.
        const searchField = (tag === "input" && typeAttr === "search") || roleAttr === "searchbox";
        // Submit controls: an explicit submission affordance. A <button> with
        // no type attribute defaults to submit inside a form.
        const submitControl =
          (tag === "button" && (typeAttr === "submit" || (!el.hasAttribute("type") && el.closest("form") !== null))) ||
          (tag === "input" && typeAttr === "submit");
        // Submit button inputs carry their visible label in the value attribute
        // (HTML-AAM: after ARIA and native labels, before title); with no value
        // the browser supplies a default label, "Submit". Without this the
        // control extracts as unlabeled noise and drops out of the action space.
        // The UA-default label applies only when value is unspecified; an
        // explicit empty value stays empty and falls through to title.
        const valueAttr = el.getAttribute("value");
        const valueLabel =
          tag === "input" && typeAttr === "submit"
            ? valueAttr ?? "Submit"
            : tag === "input" && typeAttr === "button"
              ? valueAttr ?? ""
              : "";
        const label = norm(
          labelledby ||
            norm(el.getAttribute("aria-label")) ||
            nativeLabels ||
            norm(valueLabel) ||
            norm(el.getAttribute("placeholder")) ||
            norm(el.getAttribute("title")) ||
            norm(el.innerText) ||
            norm(el.textContent) ||
            norm(slottedText(el)) ||
            "",
        );
        const href = tag === "a" ? (el.getAttribute("href") || "").slice(0, cap.href) : "";
        // A combobox that is an input is typed into; any other combobox is a
        // control that opens its list when clicked.
        const clickableRoles = ["button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "tab"];
        const clickable =
          ["a", "button"].includes(tag) ||
          clickableRoles.includes(roleAttr) ||
          (roleAttr === "combobox" && !["input", "textarea", "select"].includes(tag)) ||
          ["submit", "button", "checkbox", "radio"].includes(typeAttr);

        const selectable = tag === "select";
        // Password inputs are excluded from typeable by design, even when a
        // role attribute would otherwise make them typeable; they are stamped
        // separately so credential runs can offer fill_password. Without a
        // password source they are skipped entirely, before stamping: they
        // never consume the candidate budget on ordinary runs.
        const passwordInput = tag === "input" && typeAttr === "password";
        if (passwordInput && !includePw) continue;
        const typeable =
          !passwordInput &&
          (tag === "textarea" ||
            (tag === "input" && !["submit", "button", "checkbox", "radio", "file", "hidden", "range", "password"].includes(typeAttr)) ||
            ["searchbox", "textbox"].includes(roleAttr));
        // Enter submits from single-line fields (implicit form submission, or
        // the site's own Enter handler); a textarea Enter is just a newline.
        const enterSubmittable = typeable && tag !== "textarea";
        if (!clickable && !typeable && !selectable && !(passwordInput && includePw)) continue;
        const attr = `${attrPrefix}${out.length + 1}`;
        el.setAttribute("data-jev-id", attr);
        const expandedAttr = el.getAttribute("aria-expanded");
        const popupAttr = el.getAttribute("aria-haspopup");
        let menu: "open" | "closed" | undefined;
        if (clickable && expandedAttr === "true") menu = "open";
        else if (clickable && (expandedAttr === "false" || (popupAttr !== null && popupAttr !== "false"))) menu = "closed";
        const selected = el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-checked") === "true";
        // typeable already excludes password inputs, so no password value is ever read.
        const value = typeable && (tag === "input" || tag === "textarea") ? (el as HTMLInputElement).value.slice(0, cap.label) : "";
        const options =
          tag === "select"
            ? Array.from((el as unknown as HTMLSelectElement).options)
                // Keep each option's live DOM index alongside its label:
                // selection happens by index, so a scrubbed or truncated
                // label can never become the selection key.
                .map((o, i) => ({ i, label: (o.label || o.value || "").trim().slice(0, cap.option) }))
                .filter((o) => o.label.length > 0)
                .slice(0, 200)
            : undefined;
        out.push({ attr, tag, role: roleAttr || tag, text: label.slice(0, cap.label), href, typeAttr, clickable, typeable, searchField, submitControl, enterSubmittable, selectable, passwordInput: passwordInput || undefined, options, menu, selected: selected || undefined, value: value || undefined, behindModal: (modal !== null && !insideModal(el)) || undefined });
      }
      return out;
    },
    { cap: caps, includePw: includePasswordInputs, modal, attrPrefix },
  );
}

interface Observables {
  url: string;
  title: string;
  textLength: number;
  scrollY: number;
  excerpt: string;
  visibleExcerpt: string;
  frameText: string; // text of the visible child frames, for the judged excerpt and change detection
}

/**
 * The text of every scannable child frame, each marked "Frame:". Without it
 * a form submitted inside an iframe looks like "no visible change" and its
 * result page is invisible to the goal judgment.
 */
async function childFramesText(page: Page, cap: number): Promise<string> {
  const parts: string[] = [];
  for (const frame of (await scannableFrames(page)).slice(1)) {
    const text = await frame.evaluate(() => (document.body?.innerText ?? "").replace(/\s+/g, " ").trim()).catch(() => "");
    if (text) parts.push(`Frame: ${text}`);
  }
  return parts.join(" | ").slice(0, cap);
}

/** The main frame's visible text with the frames' text after it; frames get up to half the budget. */
function withFrameText(mainText: string, frameText: string, cap: number): string {
  if (!frameText) return mainText.slice(0, cap);
  const frameShare = Math.min(frameText.length, Math.floor(cap / 2));
  const main = mainText.slice(0, cap - frameShare - 3);
  return main ? `${main} | ${frameText.slice(0, frameShare)}` : frameText.slice(0, cap);
}

/**
 * The text of the innermost open modal dialog in document order, or null when
 * none is open. Found through a locator so a modal inside a web component's
 * shadow root counts too (Shoelace's <sl-dialog> is one).
 */
async function openModalText(page: Page, cap: number): Promise<string | null> {
  return page
    .locator(MODAL_SELECTOR)
    .evaluateAll((candidates, cap) => {
      const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
      const shown = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
      // innerText leaves out content shown through <slot> elements, which is
      // where a component dialog's message usually is, so a modal inside a
      // shadow root is read along the flat tree instead: slots give their
      // assigned nodes, hosts give their shadow root.
      const flatTreeText = (node: Node): string => {
        if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
        if (node instanceof Element && ["STYLE", "SCRIPT", "TEMPLATE"].includes(node.tagName)) return "";
        if (node instanceof HTMLSlotElement) return node.assignedNodes({ flatten: true }).map(flatTreeText).join(" ");
        const children = node instanceof Element && node.shadowRoot ? node.shadowRoot.childNodes : node.childNodes;
        return Array.from(children).map(flatTreeText).join(" ");
      };
      const modal = (candidates as HTMLElement[]).filter(shown).at(-1);
      if (!modal) return null;
      const text = modal.getRootNode() instanceof ShadowRoot ? flatTreeText(modal) : modal.innerText;
      return clean(text).slice(0, cap);
    }, cap)
    .catch(() => null);
}

async function pageObservables(page: Page, bounded: (cap: number) => number, excerptCap = 1500): Promise<Observables> {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const modalText = await openModalText(page, excerptCap);
  const data = await page
    .evaluate(({ cap, modalText }: { cap: number; modalText: string | null }) => ({
      length: document.body?.innerText?.length ?? 0,
      scrollY: window.scrollY,
      excerpt: (document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, cap),
      // What a person sees, for the judgment: the innermost open modal dialog
      // in document order, else the text inside the viewport. The start of
      // body text is often navigation or banners, and never an open dialog.
      // Credential runs keep the page-start `excerpt` instead (wired at the
      // call site): trimming and joining text nodes can split a rendered
      // secret across a space, and the redactor matches whole secrets.
      visibleExcerpt: (() => {
        const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
        const shown = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
        if (modalText !== null) return modalText;
        const parts: string[] = [];
        let length = 0;
        let visited = 0;
        const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        // Bound the work: a page that is mostly hidden (modal backdrops,
        // collapsed sections) yields few visible nodes, and without a cap the
        // walk would measure every text node in the document each step.
        for (let node = walker.nextNode(); node && length < cap && visited < 5_000; node = walker.nextNode()) {
          visited++;
          const text = clean(node.textContent);
          if (!text || !node.parentElement || !shown(node.parentElement)) continue;
          range.selectNodeContents(node);
          const r = range.getBoundingClientRect();
          if (r.width === 0 || r.height === 0 || r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) continue;
          parts.push(text);
          length += text.length + 1;
        }
        // No visible text means no visible evidence — an honest empty excerpt,
        // never the unseen start of the body that this feature exists to stop.
        return parts.join(" ").slice(0, cap);
      })(),
    }), { cap: excerptCap, modalText })
    .catch(() => ({ length: 0, scrollY: 0, excerpt: "", visibleExcerpt: "" }));
  const frameText = await childFramesText(page, excerptCap);
  // An open modal is all a person sees, so it stays the whole excerpt.
  const visibleExcerpt = modalText !== null ? data.visibleExcerpt : withFrameText(data.visibleExcerpt, frameText, excerptCap);
  return { url, title, textLength: data.length, scrollY: data.scrollY, excerpt: data.excerpt, visibleExcerpt, frameText };
}

/** What a menu toggle shows right now: its aria-expanded value and how many controls are visible. */
async function menuSnapshot(page: Page | Frame, selector: string) {
  const expanded = await page
    .locator(selector)
    .getAttribute("aria-expanded", { timeout: 1_000 })
    .catch(() => null);
  const visibleControls = await page
    .locator(`${NATIVE_CONTROL_SELECTOR}, [role=menuitem], [role=option]`)
    .evaluateAll(
      (controls) =>
        controls.filter((control) => {
          const box = control.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && getComputedStyle(control).visibility !== "hidden";
        }).length,
    )
    .catch(() => 0);
  return { expanded, visibleControls };
}

function menuOpened(before: { visibleControls: number }, after: { expanded: string | null; visibleControls: number }) {
  return after.expanded === "true" || after.visibleControls > before.visibleControls;
}

// Menu toggles are opened by code rather than left to one click, because sites differ:
// some menus open on hover only, and some ignore clicks until the site's scripts have
// loaded (nsf.gov takes seconds after its text appears). Try hover, then click, then wait
// for the page to finish loading and click again. Returns what happened, for the trace.
async function openMenu(page: Page | Frame, selector: string, bounded: (cap: number) => number): Promise<string> {
  const before = await menuSnapshot(page, selector);
  const settleMenu = () => page.waitForTimeout(350);

  await page.hover(selector, { timeout: bounded(4_000) });
  await settleMenu();
  if (menuOpened(before, await menuSnapshot(page, selector))) return "opened menu by hovering";

  await page.click(selector, { timeout: bounded(4_000) });
  await settleMenu();
  if (menuOpened(before, await menuSnapshot(page, selector))) return "opened menu";

  await page.waitForLoadState("networkidle", { timeout: bounded(6_000) }).catch(() => {});
  await page.click(selector, { timeout: bounded(4_000) });
  await settleMenu();
  if (menuOpened(before, await menuSnapshot(page, selector))) return "opened menu after the page finished loading";
  return "menu did not open";
}

/**
 * The menu, menubar, listbox or combobox that holds keyboard focus, or null.
 * Focus is followed into shadow roots, and the container is found along the
 * flat tree, so the focused item may be slotted into a component's menu.
 */
async function focusedMenu(page: Page, textCap: number): Promise<FocusedMenu | null> {
  // Keyboard focus can sit inside an iframe: the main document then reports
  // the <iframe> element as active. Child frames only count while they hold
  // focus, so a menu left focused in a frame that lost focus is ignored.
  for (const frame of page.frames()) {
    const focused = await focusedMenuInFrame(frame, textCap, frame !== page.mainFrame());
    if (focused) return focused;
  }
  return null;
}

async function focusedMenuInFrame(frame: Frame, textCap: number, requireFrameFocus: boolean): Promise<FocusedMenu | null> {
  return frame
    .evaluate(({ cap, requireFrameFocus }) => {
      if (requireFrameFocus && !document.hasFocus()) return null;
      const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, cap);
      let focused: Element | null = document.activeElement;
      while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
      if (!focused || focused === document.body) return null;
      let container: Element | null = null;
      for (let node: Node | null = focused; node && !container; node = (node as Element).assignedSlot ?? node.parentNode ?? (node as ShadowRoot).host ?? null) {
        if (node instanceof Element && ["menu", "menubar", "listbox", "combobox"].includes(node.getAttribute("role") ?? "")) container = node;
      }
      if (!container) return null;
      const root = focused.getRootNode() as Document | ShadowRoot;
      const lookUp = (ids: string | null) => (ids ?? "").split(/\s+/).map((id) => (id ? root.getElementById(id)?.textContent : "") ?? "").join(" ");
      // Comboboxes and listboxes keep focus on themselves and point at the
      // highlighted option with aria-activedescendant; menus move focus.
      const activeId = focused.getAttribute("aria-activedescendant") || container.getAttribute("aria-activedescendant");
      const activeItem = activeId ? root.getElementById(activeId) : focused === container ? null : focused;
      return {
        role: container.getAttribute("role") ?? "",
        label: clean(container.getAttribute("aria-label") || lookUp(container.getAttribute("aria-labelledby"))),
        activeItem: clean(activeItem?.textContent),
      };
    }, { cap: textCap, requireFrameFocus })
    .catch(() => null);
}

/**
 * Helium ships uBlock Origin built in. In a freshly launched browser uBO
 * spends about 4.5 s loading its filter lists; navigations started in that
 * window are held and the tab is reloaded once uBO is ready, so an early
 * click's navigation is delayed, repeated or lost. Wait, bounded, until uBO
 * reports ready. Returns whether uBO is present; at once when it is not.
 *
 * uBO's page is an extension background page that Playwright does not
 * expose, so it is reached over the browser's CDP session; the target
 * message calls are the protocol's way to talk to a non-flattened target.
 */
async function waitForContentBlocker(browser: Browser, timeoutMs: number): Promise<boolean> {
  const cdp = await browser.newBrowserCDPSession();
  try {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const ublock = targetInfos.find((target) => target.type === "background_page" && target.title === "uBlock Origin");
    if (!ublock) return false;
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: ublock.targetId, flatten: false });
    const replies = new Map<number, (value: unknown) => void>();
    cdp.on("Target.receivedMessageFromTarget", (event) => {
      const message = JSON.parse(event.message);
      replies.get(message.id)?.(message.result?.result?.value);
      replies.delete(message.id);
    });
    let nextMessageId = 1;
    const isReady = () =>
      new Promise<unknown>((resolve) => {
        const id = nextMessageId++;
        replies.set(id, resolve);
        const message = { id, method: "Runtime.evaluate", params: { expression: "self.µBlock?.readyToFilter === true", returnByValue: true } };
        cdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify(message) }).catch(() => resolve(false));
      });
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      // A reply that never comes must not outlast the deadline.
      const ready = await Promise.race([isReady(), new Promise((resolve) => setTimeout(() => resolve(false), 500))]);
      if (ready === true) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return true;
  } catch {
    // Waiting is an optimisation for one browser; never fail a run over it.
    return false;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

// uBO's startup is not over when it reports ready: a click within about
// 2.7 s of the browser's first real page load is still held. Measured on
// Helium 0.18 (Chromium 154): with a warm-up page load and 6 s since launch,
// clicks in fresh contexts reach the server in about 90 ms; with 4 s, the
// first one was still held for 1.3 s.
const CONTENT_BLOCKER_WARM_UP_MS = 6_000;

/**
 * Launches the browser and, when it carries uBlock Origin, warms it up: waits
 * for uBO, loads one throwaway page served from loopback, and returns once
 * CONTENT_BLOCKER_WARM_UP_MS have passed since launch. Without uBO it returns
 * right after launch.
 */
async function launchWarmBrowser(): Promise<Browser> {
  const launchedAt = performance.now();
  const browser = await chromium.launch({
    headless: process.env.JEV_BROWSER_HEADED !== "1",
    executablePath: resolveBrowserExecutable(process.env, existsSync),
  });
  if (!(await waitForContentBlocker(browser, 8_000))) return browser;
  const warmUpServer = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end("<!doctype html><title>warm-up</title><a href='/'>warm-up</a>");
  });
  try {
    await new Promise<void>((resolve) => warmUpServer.listen(0, "127.0.0.1", resolve));
    const { port } = warmUpServer.address() as AddressInfo;
    const warmUpContext = await browser.newContext();
    await (await warmUpContext.newPage()).goto(`http://127.0.0.1:${port}/`, { timeout: 8_000 }).catch(() => {});
    const remainingMs = CONTENT_BLOCKER_WARM_UP_MS - (performance.now() - launchedAt);
    if (remainingMs > 0) await new Promise((resolve) => setTimeout(resolve, remainingMs));
    await warmUpContext.close();
  } finally {
    warmUpServer.closeAllConnections();
    warmUpServer.close();
  }
  return browser;
}

// One warmed browser per process when keepBrowserOpen() was called: the MCP
// and HTTP servers pay the launch and warm-up once, and every run still gets
// its own fresh context (no cookies or storage shared between runs).
let sharedBrowserEnabled = false;
let sharedBrowser: Promise<Browser> | null = null;

/**
 * Reuse one browser for every run in this process instead of launching one
 * per run, and start launching it now. For long-lived processes only: an
 * open browser keeps Node running, so call closeSharedBrowser() to exit.
 */
export function keepBrowserOpen(): void {
  sharedBrowserEnabled = true;
  acquireSharedBrowser().catch(() => {}); // a failed launch is retried by the next run
}

export async function closeSharedBrowser(): Promise<void> {
  const browser = sharedBrowser;
  sharedBrowserEnabled = false;
  sharedBrowser = null;
  await (await browser?.catch(() => null))?.close().catch(() => {});
}

function acquireSharedBrowser(): Promise<Browser> {
  if (!sharedBrowser) {
    const launching = launchWarmBrowser();
    sharedBrowser = launching;
    launching.then(
      // A crashed or closed browser is relaunched by the next run.
      (browser) => browser.on("disconnected", () => {
        if (sharedBrowser === launching) sharedBrowser = null;
      }),
      () => {
        if (sharedBrowser === launching) sharedBrowser = null;
      },
    );
  }
  return sharedBrowser;
}

// Some sites (nsf.gov among them) first serve a blank, untitled page that runs a script
// and then reloads into the real one. Reading elements during that blank phase offers
// Jev nothing but scroll/back/done, and settle() would call the empty DOM "stable".
// So wait, bounded, until the page shows any text or control before the first step.
async function waitForFirstContent(page: Page, bounded: (cap: number) => number) {
  const deadline = performance.now() + bounded(12_000);
  while (performance.now() < deadline) {
    // evaluate and count throw while the page is navigating away
    const hasText = await page.evaluate(() => (document.body?.innerText?.trim().length ?? 0) > 0).catch(() => false);
    const hasContent = hasText || (await page.locator(NATIVE_CONTROL_SELECTOR).count().catch(() => 0)) > 0;
    if (hasContent) return;
    await page.waitForTimeout(250);
  }
}

// Component libraries often define their custom elements a moment after the
// load event (Shoelace's autoloader fetches each component on demand). Until
// then the elements have no shadow root, so the first step would see none of
// their controls. Wait, bounded, until no element on the page is undefined.
// Runs once per run, before the first step: a page that uses custom tags it
// never defines would otherwise pay this wait on every step.
async function waitForComponentUpgrades(page: Page, bounded: (cap: number) => number) {
  await page
    .waitForFunction(() => document.querySelector(":not(:defined)") === null, undefined, { timeout: bounded(4_000), polling: 100 })
    .catch(() => {});
}

async function settle(page: Page, bounded: (cap: number) => number) {
  await page.waitForLoadState("domcontentloaded", { timeout: bounded(4_000) }).catch(() => {});
  // Async scripts attach their click handlers before the load event, not
  // before DOMContentLoaded; a click in between lands on a control that does
  // nothing yet. Bounded, because ads and trackers can hold load back for long.
  await page.waitForLoadState("load", { timeout: bounded(5_000) }).catch(() => {});
  // A form submitted inside an iframe navigates only that frame; without
  // this the outcome is judged before the frame's result page is there.
  for (const frame of page.frames()) {
    if (frame !== page.mainFrame()) await frame.waitForLoadState("load", { timeout: bounded(3_000) }).catch(() => {});
  }
  // DOM-stability settle: two consecutive identical fingerprints mean the page
  // has stopped re-rendering, which is the signal we actually want; quiet
  // network was only ever a proxy for it, and analytics pings keep heavy sites
  // permanently noisy. Capped; a page that never settles still gets acted on.
  const deadline = performance.now() + bounded(1_500);
  let prev: string | null = null;
  while (performance.now() < deadline) {
    const textLength = await page.evaluate(() => document.body?.innerText?.length ?? 0).catch(() => null);
    const controlCount = await page.locator(NATIVE_CONTROL_SELECTOR).count().catch(() => null);
    const fingerprint = textLength === null || controlCount === null ? null : `${textLength}:${controlCount}`;
    if (fingerprint !== null && fingerprint === prev) return; // DOM went quiet
    prev = fingerprint;
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(400); // never settled; act anyway
}

// ── The loop ─────────────────────────────────────────────────────────────────
export async function navigate(options: NavigateOptions, externalSignal?: AbortSignal) {
  const {
    task,
    startUrl,
    maxSteps = 24,
    maxSeconds = 180,
    allowTyping = true,
    format = "text",
    screenshot = "final",
  } = options;
  const maxChars = options.maxChars ?? DEFAULT_CAPS[format];
  const started = performance.now();
  const deadlineAt = started + maxSeconds * 1000;

  // Credential-run guards run before any timer, listener, or browser is
  // armed: a rejected direct-library call must not leak the deadline timer
  // (or the caller's abort listener) for maxSeconds.
  // Injected-page guards share the pre-timer region: a rejected call must not
  // leak the deadline timer or the caller's abort listener either.
  if (options.page && options.recordDir) {
    throw new Error("navigate(): video recording is refused on runs with an injected page");
  }
  if (!options.page && !startUrl) {
    throw new Error("startUrl is required when page is not supplied");
  }
  // Seed cookies are credentials of the same rank as the password value, so
  // their guards share the pre-timer region: a rejected call must not arm
  // the deadline timer or any listener. addCookies on a caller-owned context
  // would silently rewrite the caller's own session state, so cookies plus
  // an injected page is refused before anything is touched.
  let seedCookies: ReturnType<typeof resolveCookies> = [];
  if (options.cookies?.length) {
    if (options.page) {
      throw new Error("navigate(): seed cookies are refused on runs with an injected page (context.addCookies would mutate the caller's context)");
    }
    seedCookies = resolveCookies(options.cookies, startUrl!);
    // Video frames cannot be redacted; a seeded cookie can render into them.
    if (options.recordDir) throw new Error("navigate(): video recording is refused on runs with seed cookies");
    assertNoPlaywrightDebug();
    // Same validation as the password: a value that could never be redacted
    // reliably (empty, control characters, below the safe length) is
    // rejected before the run starts.
    for (const c of seedCookies) validateSecretBuffer(Buffer.from(c.value, "utf8"), `cookie "${c.name}"`);
  }
  let redactor: Redactor | null = null;
  let trustedOrigin: string | null = null;
  let passwordValue: string | null = null;
  if (options.password) {
    const origin = parseTrustedOrigin(options.password.origin);
    if (!origin) {
      throw new Error("navigate(): password.origin must be an exact https origin (http only on localhost), e.g. https://acme.com");
    }
    trustedOrigin = origin;
    assertNoPlaywrightDebug();
    if (options.recordDir) throw new Error("navigate(): video recording is refused on runs with a password source");
    // A caller context created with recordVideo (or page.video() non-null for
    // any reason) records the injected page too, and video frames cannot be
    // redacted, so credential runs refuse it exactly like recordDir.
    if (options.page?.video()) throw new Error("navigate(): password runs are refused on an injected page that is being recorded");
    // Validate here, not just in the CLI/MCP adapters: library callers call
    // navigate() directly, and an invalid secret (CR/LF, below-minimum or
    // normalization-collapsing length) could never be redacted reliably.
    passwordValue = validateSecretBuffer(Buffer.from(options.password.value, "utf8"));
  }
  // One redactor covers every secret this run carries: the password value and
  // each seed-cookie value. Longest-first application means a value that is a
  // prefix of another (two cookies sharing a token prefix) still redacts.
  const runSecrets = [passwordValue, ...seedCookies.map((c) => c.value)].filter((v): v is string => v !== null);
  if (runSecrets.length) redactor = makeRedactor(runSecrets);
  const R = (s: string): string => redactor?.redact(s) ?? s;
  // The task itself is model-facing: if a caller ignored the docs and put the
  // value in the task string, scrub it before any model or typing generator
  // sees it, so "the model never sees the value" holds unconditionally.
  const safeTask = R(task);

  // Strict typing-provider configuration is validated before any timer,
  // listener, or browser is armed, like the credential guards above: a run
  // with JEV_BROWSER_TYPE_PROVIDER set to an unknown provider (or without a
  // valid key for the named one) refuses to start instead of silently using
  // another provider. Runs with typing disabled ignore typing config at all,
  // so a broken config can always be worked around with allowTyping: false.
  const typingGenerator = allowTyping ? createTypingGenerator() : null;
  const transport = options.transport ?? resolvePrivateTransport();

  // One abort source per run: the wall-clock deadline, optionally composed
  // with caller cancellation (the MCP layer forwards its signal).
  const controller = new AbortController();
  const deadlineTimer = setTimeout(() => controller.abort(new Error("deadline-exceeded")), maxSeconds * 1000);
  const onExternalAbort = () => controller.abort(new Error("cancelled-by-caller"));
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  if (externalSignal?.aborted) controller.abort(new Error("cancelled-by-caller"));

  // The model is resolved per run, not at import time, so importing the
  // library has no configuration side effects and env changes apply per call.
  const requestedModel = process.env.JEV_BROWSER_MODEL ?? "jev-latest";
  const budget: RunBudget = {
    usage: { jev_calls: 0, input_tokens: 0, output_tokens: 0, est_cost_usd: 0 },
    transport,
    signal: controller.signal,
    deadlineAt,
    requestedModel,
    model: requestedModel,
    provider: null,
  };
  const remaining = () => Math.max(0, deadlineAt - performance.now());
  const bounded = (cap: number) => Math.max(250, Math.min(cap, remaining() || 250));

  // Credential runs size each capture window as visible limit + the longest
  // secret representation, so an echo that starts inside the visible window
  // is always captured whole: redaction sees the complete variant before any
  // display slice, and no prefix of the value can survive the boundary.
  // Non-credential runs keep the original extraction semantics.
  const maxVariant = redactor?.maxVariantLength ?? 0;
  const captureCaps = redactor
    ? { label: CREDENTIAL_VISIBLE.label + maxVariant, option: CREDENTIAL_VISIBLE.option + maxVariant, href: CREDENTIAL_VISIBLE.href + maxVariant }
    : DEFAULT_CAPTURE_CAPS;
  const excerptCap = redactor ? STATE_EXCERPT_CHARS + maxVariant : STATE_EXCERPT_CHARS;

  const steps: StepRecord[] = [];
  const warnings: TypingWarning[] = [];
  // Bot-protection state: the last cf-mitigated value seen on a main-document
  // response, and the detection (if any) that stopped or annotated the run.
  let cfMitigated: string | null = null;
  let botProtection: BotProtection | null = null;
  const recordTypingWarning = (
    step: number,
    code: TypingWarningCode,
    message: string,
    extra: { finishReason?: string; fallback?: string } = {},
  ) => {
    warnings.push(
      typingWarning(code, step, {
        message: R(message),
        provider: typingGenerator?.provider ?? null,
        model: typingGenerator?.modelId ?? null,
        finishReason: extra.finishReason,
        fallback: extra.fallback,
      }),
    );
  };
  const consoleEvents: ConsoleEvent[] = [];
  let consoleDropped = 0;
  const currentStep = { n: 0 };
  const extractionProblems: string[] = [];
  // Set immediately before a fill is attempted: even a failed fill counts as
  // exposed, so the final screenshot stays suppressed. passwordFilled is set
  // only when a fill actually landed; a refused fill (wrong origin, element
  // changed) must not report success.
  // An injected page may already visibly contain or reflect the configured
  // value before any fill: a caller-typed login field, a logged-in page that
  // echoes it. Owned password runs cannot (the value only reaches the page
  // through a fill), so exposure starts armed exactly for injected credential
  // pages. Cookie runs are armed from run start on any page: the seeded
  // values sit in the browser before the first navigation, so the very first
  // rendered page can already reflect one into pixels.
  let credentialUsed = Boolean(options.password && options.page) || seedCookies.length > 0;
  let passwordFilled = false;

  let browser: Browser | null = null;
  let ownsBrowser = false;
  let usesSharedBrowser = false;
  let runContext: BrowserContext | null = null; // the context this run created, closed when it ends
  let observedContext: BrowserContext | null = null;
  let onNewPage: ((page: Page) => void) | null = null;
  const observerCleanups: Array<() => void> = [];
  let status = "error";

  const recordEvent = (event: Omit<ConsoleEvent, "step">) => {
    if (consoleEvents.length >= MAX_CONSOLE_EVENTS) {
      consoleDropped += 1;
      return;
    }
    consoleEvents.push({ ...event, step: currentStep.n });
  };

  const attachPageObservers = (p: Page) => {
    // Redaction happens on the full string before any cap: a truncated echo
    // of the secret would otherwise survive the slice boundary.
    const onConsole = (msg: ConsoleMessage) => {
      const type = msg.type();
      if (type !== "error" && type !== "warning") return;
      recordEvent({ type: `console_${type}` as ConsoleEvent["type"], text: R(msg.text()).slice(0, 300), page: R(p.url()).slice(0, 120) });
    };
    const onPageError = (err: Error) => recordEvent({ type: "page_error", text: R(String(err)).slice(0, 300), page: R(p.url()).slice(0, 120) });
    const onRequestFailed = (req: Request) =>
      recordEvent({
        type: "request_failed",
        text: R(`${req.method()} ${req.url()} ${req.failure()?.errorText ?? ""}`).slice(0, 300),
        page: R(p.url()).slice(0, 120),
      });
    p.on("console", onConsole);
    p.on("pageerror", onPageError);
    p.on("requestfailed", onRequestFailed);
    observerCleanups.push(() => {
      p.off("console", onConsole);
      p.off("pageerror", onPageError);
      p.off("requestfailed", onRequestFailed);
    });
  };

  try {
    ownsBrowser = !options.page;
    usesSharedBrowser = ownsBrowser && sharedBrowserEnabled;
    if (ownsBrowser) browser = usesSharedBrowser ? await acquireSharedBrowser() : await launchWarmBrowser();
    if (!options.page) {
      runContext = await browser!.newContext({
        viewport: { width: 1024, height: 640 },
        ...(options.recordDir ? { recordVideo: { dir: options.recordDir } } : {}),
      });
    }
    const context: BrowserContext = options.page ? options.page.context() : runContext!;
    observedContext = context;
    // Seeded before the first navigation (the guards already ran pre-timer;
    // cookies + injected page and cookies + recording were both refused, so
    // this only ever touches a run-owned context).
    if (seedCookies.length) await context.addCookies(seedCookies);
    // No Playwright default (30s) may ever outlive the run budget.
    if (ownsBrowser) {
      context.setDefaultTimeout(8_000);
    }
    let page = options.page ?? (await context.newPage());
    const videoPathPromise = options.recordDir ? page.video()?.path() : undefined;
    attachPageObservers(page);
    // Cloudflare's official bot-protection signal: the cf-mitigated response
    // header on a main-document response. Recorded for evidence; the decision
    // to stop a run always also requires page evidence (the challenge may
    // auto-pass and paint the real page after the header was seen).
    const runPage = page;
    const onResponse = (res: Response) => {
      if (res.request().isNavigationRequest() && res.frame() === runPage.mainFrame()) {
        const value = res.headers()["cf-mitigated"];
        if (value) cfMitigated = value;
      }
    };
    page.on("response", onResponse);
    observerCleanups.push(() => runPage.off("response", onResponse));
    let pendingPage: Page | null = null;
    onNewPage = (p) => {
      attachPageObservers(p); // adopted tabs keep producing diagnostics
      pendingPage = p;
    };
    context.on("page", onNewPage);

    if (startUrl) {
      await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: bounded(30_000) });
      await waitForFirstContent(page, bounded);
      await settle(page, bounded);
      await waitForComponentUpgrades(page, bounded);
    }

    // Bot-protection interstitials are walls, not pages to reason about. The
    // probe is DOM-only on purpose: a stale cf-mitigated header must not keep
    // a page "blocked" after its challenge auto-passed. A detected challenge
    // gets one short bounded window to clear itself before the run is
    // declared blocked; a hard block page never clears, so it waits none.
    // settleBotProtection distinguishes a wall whose persistence was VERIFIED
    // (the window ran and the wall was still there) from an unverified one
    // (no budget for the window): only a verified challenge, or any hard
    // block, may become the run's outcome; an unverified challenge keeps the
    // budget outcome (timeout) and is reported as evidence instead.
    const probeBotProtection = async (): Promise<BotProtection | null> => {
      const probe = await page
        .evaluate((cap) => ({
          title: document.title,
          body: (document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, cap),
        }), excerptCap)
        .catch(() => ({ title: "", body: "" }));
      return detectBotProtection({ title: probe.title, excerpt: probe.body });
    };
    const settleBotProtection = async (
      detected: BotProtection,
    ): Promise<{ protection: BotProtection; verified: boolean } | null> => {
      // A hard block never clears, so the page itself establishes persistence.
      if (detected.kind !== "challenge") return { protection: detected, verified: true };
      const settleDeadline = performance.now() + bounded(8_000);
      let verified = false;
      while (performance.now() < settleDeadline && remaining() > 1_000) {
        await page.waitForTimeout(bounded(1_000));
        const now = await probeBotProtection();
        if (!now) return null; // cleared: the real page painted
        if (now.kind === "block") return { protection: now, verified: true };
        verified = true; // still a challenge after a wait: persistence verified
      }
      return { protection: detected, verified };
    };
    // A settled wall becomes the outcome only when its persistence was
    // established (any hard block, or a challenge that survived its window).
    // Otherwise the deadline has effectively fired and the budget outcome
    // keeps precedence: the wall is annotated, the status stays timeout.
    const wallIsOutcome = (settled: { protection: BotProtection; verified: boolean }) =>
      settled.protection.kind === "block" || settled.verified;

    let lastExecuted: string | null = null;
    // Machine state for repeat recovery, decoupled from the display string:
    // "typed" (a fill happened but the page did not change) and "no_change"
    // (nothing observable happened) both make a repeat proposal redundant.
    let lastRedundant: "typed" | "no_change" | null = null;
    // The stuck watcher may press Escape in place of stopping, once per run:
    // a second stuck signal after that means Escape did not help.
    let escapeRecoveryUsed = false;
    // Menu text is page text: credential runs scrub it like element labels.
    const readFocusedMenu = async (): Promise<FocusedMenu | null> => {
      const focused = await focusedMenu(page, captureCaps.label);
      if (!focused || !redactor) return focused;
      return {
        role: focused.role,
        label: redactor.redactCapped(focused.label, CREDENTIAL_VISIBLE.label),
        activeItem: redactor.redactCapped(focused.activeItem, CREDENTIAL_VISIBLE.label),
      };
    };
    const history: Array<{ step: number; action: string; outcome: string }> = [];

    for (let step = 1; step <= maxSteps; step++) {
      currentStep.n = step;
      if (remaining() <= 0) {
        status = "timeout";
        break;
      }

      // Fail fast on bot protection, before elements are extracted or a Jev
      // call is spent: an interstitial offers nothing to act on, and burning
      // steps on one only produces a confident "done" on a wall. Detection
      // requires page evidence (probeBotProtection is DOM-only); a challenge
      // that clears within its window lets the run proceed normally.
      const detectedProtection = await probeBotProtection();
      if (detectedProtection) {
        const settledProtection = await settleBotProtection(detectedProtection);
        if (settledProtection) {
          botProtection = settledProtection.protection;
          status = wallIsOutcome(settledProtection) ? "blocked" : "timeout";
          break;
        }
      }

      const { raw, frames: stepFrames } = await extractAndStamp(page, bounded, captureCaps, Boolean(options.password));
      // A page that already holds the value can echo it into any extracted
      // string (labels, hrefs, option text). Scrub host-side before the
      // action space or any model-facing state is built from these. These
      // strings were captured longer than the display limit on purpose (so
      // echoes starting inside the window are captured whole); they go
      // through the position-preserving path so the display slice can never
      // pull a partially captured echo into view.
      if (redactor) {
        for (const el of raw) {
          el.text = redactor.redactCapped(el.text, CREDENTIAL_VISIBLE.label);
          el.href = redactor.redactCapped(el.href, CREDENTIAL_VISIBLE.href);
          if (el.frameHost) el.frameHost = redactor.redact(el.frameHost);
          if (el.value) el.value = redactor.redactCapped(el.value, CREDENTIAL_VISIBLE.label);
          if (el.options) el.options = el.options.map((o) => ({ i: o.i, label: redactor.redactCapped(o.label, CREDENTIAL_VISIBLE.option) }));
        }
      }
      const { elements, truncated } = buildActionSpace(raw, { passwordActive: allowTyping && Boolean(options.password) });
      const observables = await pageObservables(page, bounded, excerptCap);

      // Empty action space is still judged normally: controls-only criteria
      // (scroll/back/done) plus the page excerpt. goal_done can and should
      // fire on terminal pages with no interactive elements.
      const state = {
        task: safeTask,
        current_page: { url: R(observables.url), title: R(observables.title) },
        page_text_excerpt: redactor
          ? redactor.redactCapped(observables.excerpt, STATE_EXCERPT_CHARS)
          : observables.visibleExcerpt.slice(0, STATE_EXCERPT_CHARS),
        interactive_elements: elements.map((e) => ({ id: e.id, description: e.description })),
        element_list_truncated: truncated,
        no_interactive_elements: elements.length === 0,
        history,
      };
      const focusedBefore = await readFocusedMenu();
      const keyActions = buildKeyActions(focusedBefore);
      const answers = await askJev(budget, state, stepQuestions(buildCriteria(elements, keyActions)));
      const actionAnswer = answers.action as Extract<JevAnswer, { type: "choice" }>;
      const proposed: string = actionAnswer.choice;
      const probabilities: Record<string, number> = actionAnswer.probabilities ?? {};
      const base = {
        step,
        t_ms: Math.round(performance.now() - started),
        proposed_action: proposed,
        confidence: actionAnswer.confidence ?? null,
        top_probability: probabilities[proposed] ?? null,
        goal_done: (answers.goal_done as Extract<JevAnswer, { type: "noul" }>).noul,
        stuck: (answers.stuck as Extract<JevAnswer, { type: "noul" }>).noul,
      };

      // Stop gates run BEFORE execution: a watcher that fires on the current
      // state must not be overridden by acting on that state.
      if (proposed === "done") {
        steps.push({ ...base, executed_action: null, detail: "done proposed; not executed", outcome: "agent declared done before acting" });
        status = "done";
        break;
      }
      if ((answers.goal_done as Extract<JevAnswer, { type: "noul" }>).noul > 0.85) {
        steps.push({ ...base, executed_action: null, detail: "goal watcher fired; proposed action not executed", outcome: "goal watcher fired before acting" });
        status = "goal_achieved";
        break;
      }
      // A menu opened by mistake can cover the page and make every other
      // action fail. When that is the likely cause (a menu holds focus),
      // close it with Escape once before giving up.
      let stuckRecovery = false;
      if ((answers.stuck as Extract<JevAnswer, { type: "noul" }>).noul > 0.85 && step > 2) {
        if (keyActions.press_escape && !escapeRecoveryUsed) {
          stuckRecovery = true;
          escapeRecoveryUsed = true;
        } else {
          steps.push({ ...base, executed_action: null, detail: "stuck watcher fired; proposed action not executed", outcome: "stuck watcher fired before acting" });
          status = "stuck";
          break;
        }
      }

      // Repeat-no-op recovery: switch to the next-best option from the
      // distribution. No low-confidence override by design: split probability
      // across similar elements is usually several acceptable alternatives.
      let chosen = proposed;
      let recoveryReason: string | undefined;
      if (stuckRecovery) {
        chosen = "press_escape";
        recoveryReason = "stuck watcher fired while a menu had focus; pressed Escape to close it instead of stopping";
      } else if (lastExecuted === proposed && lastRedundant !== null) {
        // "done" is excluded like "back": an alternate with any positive
        // probability is too weak a basis to terminate the run. Termination
        // stays with the model's own proposal and the goal/stuck watchers.
        const alternate = pickAlternate(probabilities, new Set([proposed, "done"]));
        if (alternate) {
          chosen = alternate;
          recoveryReason = "repeated action had no further effect; switched to next-best option";
        }
      }

      const element = elements.find(
        (e) =>
          chosen === `click_${e.id}` ||
          chosen === `type_${e.id}` ||
          chosen === `select_${e.id}` ||
          chosen === `submit_${e.id}` ||
          chosen === `search_${e.id}` ||
          chosen === `fill_password_${e.id}`,
      );
      // Element actions run in the element's own frame; the main frame when
      // it has none. A frame that detached since the scan makes the action
      // fail like any other stale element.
      const target: Frame = element?.frameIndex !== undefined ? stepFrames[element.frameIndex] : page.mainFrame();

      let detail = chosen;
      let actionError: string | undefined;
      let typedIntoLabel: string | null = null;
      try {
        if (chosen === "back") {
          const wentBack = await page.goBack({ waitUntil: "domcontentloaded", timeout: bounded(10_000) }).catch(() => null);
          detail = wentBack ? "went back" : "no history to go back to";
        } else if (chosen === "scroll_down" || chosen === "scroll_up") {
          await page.evaluate(
            (dir) => window.scrollBy(0, dir * window.innerHeight * 0.8),
            chosen === "scroll_down" ? 1 : -1,
          );
          detail = chosen;
        } else if (Object.hasOwn(MENU_KEYS, chosen)) {
          // Focus can move while Jev decides. Check again right before the
          // press, so Enter can never land on a form field outside the menu.
          const focusedNow = await readFocusedMenu();
          if (!focusedNow) {
            actionError = "focus is no longer inside a menu; no key was pressed";
          } else {
            await page.keyboard.press(MENU_KEYS[chosen]);
            detail = `pressed ${MENU_KEYS[chosen]} in the focused ${focusedNow.role}`;
          }
        } else if (!element) {
          actionError = `unknown action ${chosen}`;
        } else if (chosen.startsWith("type_")) {
          if (!allowTyping) {
            actionError = "typing disabled by caller";
          } else if (!typingGenerator) {
            // An ordinary field is never filled with a guess: no typing
            // provider means nothing gets typed, loudly.
            actionError = "typing generator failed; nothing was typed";
            recordTypingWarning(step, "typing_fallback_no_provider", "no typing provider is configured; ordinary fields are left empty rather than filled with a guess");
          } else {
            const generated = await generateTextToType(budget.signal, typingGenerator, safeTask, element.description, R(page.url()));
            if (!generated.ok) {
              // A failed or empty generation types nothing: keyword soup in a
              // username or email field guarantees failure while looking like
              // a typing attempt happened (#2).
              actionError = "typing generator failed; nothing was typed";
              recordTypingWarning(step, generated.code, generated.message, { finishReason: generated.finishReason });
            } else {
              // Fill only: submitting is a separate submit_eN decision, so an
              // ordinary form is never submitted mid-task by a field fill.
              await target.fill(selectorFor(element), generated.text, { timeout: bounded(4_000) });
              detail = `typed "${generated.text}" via ${generated.via}`;
              typedIntoLabel = element.description.match(/"([^"]*)"/)?.[1] ?? element.kind;
            }
          }
        } else if (chosen.startsWith("search_")) {
          if (!allowTyping) {
            actionError = "typing disabled by caller";
          } else {
            let text: string;
            let via: string;
            if (!typingGenerator) {
              text = heuristicQuery(safeTask);
              via = "keyword-heuristic";
              recordTypingWarning(step, "typing_fallback_no_provider", "no typing provider is configured; search fields fall back to the task-keyword heuristic", { fallback: "keyword-heuristic" });
            } else {
              const generated = await generateTextToType(budget.signal, typingGenerator, safeTask, element.description, R(page.url()));
              if (generated.ok) {
                text = generated.text;
                via = generated.via;
              } else {
                // Search fields keep the heuristic: it is search-tuned, and a
                // search query built from the task words is often still
                // useful. The run is marked degraded either way.
                text = heuristicQuery(safeTask);
                via = "keyword-heuristic-after-generator-error";
                recordTypingWarning(step, generated.code, generated.message, { finishReason: generated.finishReason, fallback: "keyword-heuristic" });
              }
            }
            await target.fill(selectorFor(element), text, { timeout: bounded(4_000) });
            await target.press(selectorFor(element), "Enter", { timeout: bounded(4_000) });
            detail = `searched "${text}" via ${via}`;
            typedIntoLabel = element.description.match(/"([^"]*)"/)?.[1] ?? element.kind;
          }
        } else if (chosen.startsWith("submit_")) {
          if (element.submitVia === "click") {
            await target.click(selectorFor(element), { timeout: bounded(4_000) });
            detail = `submitted form: ${element.description}`;
          } else {
            await target.press(selectorFor(element), "Enter", { timeout: bounded(4_000) });
            detail = `submitted form: Enter on ${element.description}`;
          }
        } else if (chosen.startsWith("select_")) {
          const opts = element.options ?? [];
          if (opts.length === 0) {
            actionError = "select had no options";
          } else {
            // Labels are scrubbed and display-capped, so the model picks by
            // label but selection happens by live DOM index: a scrubbed or
            // truncated label can never become the selection key.
            const optionAnswer = await askJev(
              budget,
              { task: safeTask, page: { url: R(observables.url), title: R(observables.title) }, dropdown: element.description, options: opts.map((o) => o.label) },
              { option: selectOptionQuestion(element.description, opts.map((o) => o.label)) },
            ).catch((error) => {
              if (budget.signal.aborted) throw budget.signal.reason;
              if (error instanceof InvalidJevAnswer) throw error;
              throw new InvalidJevAnswer(`Jev provider ${budget.transport.name} question option: request failed`);
            });
            const pickedIndex = Number((optionAnswer.option as Extract<JevAnswer, { type: "choice" }>).choice.slice(1));
            const opt = opts[pickedIndex];
            await target.selectOption(selectorFor(element), { index: opt.i }, { timeout: bounded(4_000) });
            detail = `selected "${opt.label}"`;
          }
        } else if (chosen.startsWith("fill_password_")) {
          if (!options.password || !trustedOrigin) {
            actionError = "no password source is active";
          } else {
            // The check and the fill run as ONE in-page task on the element
            // the locator resolved: type, connectedness, and page origin are
            // read and the value written inside the same JS task, so no
            // navigation or DOM mutation can interleave between validation
            // and assignment. The value is set through the native setter and
            // announced with input/change events, matching fill() semantics
            // for framework-controlled inputs.
            credentialUsed = true; // even a failed attempt suppresses the screenshot
            const handle = target.locator(selectorFor(element));
            const fill = await handle
              .evaluate((el, args) => {
                const input = el;
                if (!(input instanceof HTMLInputElement) || input.type !== "password" || !input.isConnected) {
                  return { ok: false as const, reason: "not_password_input" as const };
                }
                if (window.location.origin !== args.trustedOrigin) {
                  return { ok: false as const, reason: "origin_mismatch" as const, origin: window.location.origin };
                }
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
                if (setter) setter.call(input, args.value);
                else input.value = args.value;
                input.dispatchEvent(new Event("input", { bubbles: true }));
                input.dispatchEvent(new Event("change", { bubbles: true }));
                return { ok: true as const };
              }, { trustedOrigin, value: passwordValue! })
              .catch(() => null);
            if (!fill) {
              actionError = "password fill failed; the element disappeared or the page navigated";
            } else if (!fill.ok && fill.reason === "origin_mismatch") {
              actionError = `origin_mismatch: refused to fill on ${fill.origin}; the password is bound to ${trustedOrigin}`;
            } else if (!fill.ok) {
              actionError = "element is no longer a native password input";
            } else {
              passwordFilled = true;
              const pwLabel = element.description.match(/"([^"]*)"/)?.[1] ?? "password";
              detail = `filled password into "${pwLabel}"; not submitted`;
            }
          }
        } else if (element.menu === "closed") {
          detail = `${await openMenu(target, selectorFor(element), bounded)}: ${element.description}`;
        } else {
          await target.click(selectorFor(element), { timeout: bounded(4_000) });
          detail = element.description;
        }
      } catch (error) {
        if (controller.signal.aborted) throw error; // deadline/cancellation propagates
        if (error instanceof InvalidJevAnswer) throw error; // malformed second-stage answer is a run error, never an action fallback
        actionError = R((error as Error).message).slice(0, 160);
      }

      await settle(page, bounded);
      if (pendingPage) {
        page = pendingPage;
        pendingPage = null;
        await settle(page, bounded);
        detail += " (followed new tab)";
      }

      const after = await pageObservables(page, bounded, excerptCap);
      // An arrow key changes only which item is highlighted. Report that as
      // an effect, or a second press_down reads as a no-op and repeat
      // recovery switches away from it.
      const focusedAfter = Object.hasOwn(MENU_KEYS, chosen) && !actionError ? await readFocusedMenu() : null;
      const highlightMoved = focusedAfter !== null && focusedAfter.activeItem !== "" && focusedAfter.activeItem !== focusedBefore?.activeItem;
      // Execution failures are attributed to the action, not to ambient page
      // changes that happened to occur in the same window.
      const pageUnchanged =
        !actionError &&
        after.url === observables.url &&
        after.title === observables.title &&
        Math.abs(after.textLength - observables.textLength) <= 50 &&
        Math.abs(after.scrollY - observables.scrollY) <= 40 &&
        after.frameText === observables.frameText &&
        !highlightMoved;
      const outcome = actionError
        ? "action failed"
        : after.url !== observables.url
          ? `navigated to ${R(after.url)}`
          : after.title !== observables.title
            ? `page changed: "${R(after.title)}"`
            : Math.abs(after.textLength - observables.textLength) > 50
              ? "page content changed"
              : Math.abs(after.scrollY - observables.scrollY) > 40
                ? "scrolled"
                : after.frameText !== observables.frameText
                  ? "content inside a frame changed"
                  : highlightMoved
                  ? `highlighted "${focusedAfter.activeItem}"`
                  : typedIntoLabel !== null
                  ? // A fill is a real effect even when nothing navigates: the
                    // field now holds text. Say so, or the stuck watcher
                    // misreads a successful type as a no-op.
                    `typed into "${typedIntoLabel}"; no visible page change`
                  : "no visible change";
      lastRedundant = pageUnchanged ? (typedIntoLabel !== null ? "typed" : "no_change") : null;

      lastExecuted = chosen;
      history.push({ step, action: chosen, outcome: R(outcome) });
      steps.push({
        ...base,
        executed_action: chosen,
        detail: R(detail),
        recovery_reason: recoveryReason,
        action_error: actionError ? R(actionError) : undefined,
        outcome: R(outcome),
      });

      if (step === maxSteps) status = "max_steps";
    }

    let finalObservables = await pageObservables(page, bounded, excerptCap);
    // The final page gets the last word. A wall that appeared after the last
    // action (or after a done/goal judgment while the page changed under it)
    // must not masquerade as done: DOM-only detection (no header, so a
    // passed-challenge header cannot manufacture page evidence) with the same
    // settle window flips the status to blocked. The settle window can also
    // REPAINT the page (a challenge that auto-passes), so observables are
    // re-captured after it: the flip decision, any annotation, and the
    // reported final page must all describe the page that is there now, not
    // the one captured before the wait. A wall that could not be verified
    // persistent (no budget for the window) flips nothing; header-only
    // evidence stays annotation and never changes the outcome either.
    if (!botProtection) {
      const finalDecision = detectBotProtection({ title: finalObservables.title, excerpt: finalObservables.excerpt });
      if (finalDecision) {
        const settledFinal = await settleBotProtection(finalDecision);
        finalObservables = await pageObservables(page, bounded, excerptCap);
        if (settledFinal && wallIsOutcome(settledFinal)) {
          botProtection = settledFinal.protection;
          status = "blocked";
        }
      }
    }
    if (!botProtection) {
      botProtection = detectBotProtection({
        title: finalObservables.title,
        excerpt: finalObservables.excerpt,
        cfMitigated,
      });
    }
    const publicBotProtection = botProtection
      ? { provider: botProtection.provider, kind: botProtection.kind, evidence: botProtection.evidence, guidance: botProtection.guidance }
      : undefined;
    let payload: { truncated: boolean; true_length: number; content: string } | null = null;
    let screenshotBase64: string | null = null;
    let screenshotSuppressed: "credential-fill" | undefined;
    try {
      payload = await extractPayload(page, format, maxChars, bounded, R);
    } catch (error) {
      // Redact the full message at push time; the display slice happens at
      // result assembly, after redaction, so no prefix of an echoed value can
      // survive the 160-char boundary.
      extractionProblems.push(R(`page payload: ${(error as Error).message}`));
    }
    if (screenshot === "final") {
      if (credentialUsed) {
        // The page can reflect the filled value; no capture after exposure.
        screenshotSuppressed = "credential-fill";
      } else {
        try {
          const buffer = await page.screenshot({ type: "jpeg", quality: 70, timeout: bounded(10_000) });
          screenshotBase64 = buffer.toString("base64");
        } catch (error) {
          extractionProblems.push(R(`screenshot: ${(error as Error).message}`));
        }
      }
    }

    if (ownsBrowser) await releaseBrowser(browser, runContext, usesSharedBrowser);
    const videoPath = (await videoPathPromise?.catch(() => undefined)) ?? null;
    const result = {
      status,
      video_path: videoPath,
      final_url: R(finalObservables.url),
      final_title: R(finalObservables.title),
      format,
      max_chars: maxChars,
      page: payload,
      extraction_problems: extractionProblems.length ? extractionProblems.map(R).map((s) => s.slice(0, 160)) : undefined,
      steps,
      console_events: consoleEvents,
      console_events_dropped: consoleDropped,
      usage: { ...budget.usage },
      elapsed_ms: Math.round(performance.now() - started),
      model: budget.model,
      jev_provider: budget.provider,
      degraded: warnings.length > 0,
      warnings,
      typing_provider: typingGenerator?.provider ?? null,
      typing_model: typingGenerator?.modelId ?? null,
      password_filled: passwordFilled || undefined,
      bot_protection: publicBotProtection,
      screenshot_suppressed: screenshotSuppressed,
      screenshot_base64_jpeg: screenshotBase64,
    };
    // Final boundary: a deep pass over everything this run returns, so no
    // field added later (payloads, traces, problems) can echo the value in any
    // representation the redactor knows. Earlier R() calls stay: they keep the
    // model-facing inputs clean during the run, not just its outputs.
    return redactor ? redactor.redactDeep(result) : result;
  } catch (runError) {
    const aborted = controller.signal.aborted;
    status = aborted && String((runError as Error).message).includes("deadline") ? "timeout" : "error";
    const failure = {
      status,
      error: R(aborted ? `aborted: ${(runError as Error).message}` : (runError as Error).message),
      steps,
      console_events: consoleEvents,
      console_events_dropped: consoleDropped,
      usage: { ...budget.usage },
      elapsed_ms: Math.round(performance.now() - started),
      model: budget.model,
      jev_provider: budget.provider,
      degraded: warnings.length > 0,
      warnings,
      typing_provider: typingGenerator?.provider ?? null,
      typing_model: typingGenerator?.modelId ?? null,
      bot_protection: botProtection
        ? { provider: botProtection.provider, kind: botProtection.kind, evidence: botProtection.evidence, guidance: botProtection.guidance }
        : undefined,
    };
    return redactor ? redactor.redactDeep(failure) : failure;
  } finally {
    clearTimeout(deadlineTimer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    if (observedContext && onNewPage) observedContext.off("page", onNewPage);
    for (const cleanup of observerCleanups.splice(0).reverse()) cleanup();
    if (ownsBrowser) await releaseBrowser(browser, runContext, usesSharedBrowser);
  }
}

/**
 * Ends a run's hold on the browser it created: a shared browser only loses
 * the run's context (closing it also finishes any video), a per-run browser
 * is closed. Safe to call twice.
 */
async function releaseBrowser(browser: Browser | null, runContext: BrowserContext | null, shared: boolean): Promise<void> {
  if (shared) await runContext?.close().catch(() => {});
  else await browser?.close().catch(() => {});
}

async function extractPayload(
  page: Page,
  format: string,
  maxChars: number,
  bounded: (cap: number) => number,
  redact: (s: string) => string = (s) => s,
): Promise<{ truncated: boolean; true_length: number; content: string }> {
  let content = "";
  if (format === "html") {
    // Strip the extraction stamps so returned HTML matches the page the user
    // would see, not the instrumented one.
    content = await page.evaluate(
      () => {
        const clone = document.documentElement.cloneNode(true) as HTMLElement;
        clone.querySelectorAll("[data-jev-id]").forEach((el) => el.removeAttribute("data-jev-id"));
        return clone.outerHTML;
      });
  } else if (format === "aria") {
    content = await page.locator("body").ariaSnapshot({ timeout: bounded(10_000) });
  } else if (format === "markdown") {
    const html = await page.evaluate(() => document.body?.innerHTML ?? "");
    // Redact the source HTML before conversion: entity and attribute forms
    // of an echoed value exist in the DOM string, not the markdown output,
    // and turndown can mangle them past the redactor's patterns.
    content = turndown.turndown(redact(html));
  } else {
    content = await page.evaluate(() => document.body?.innerText ?? "");
  }
  content = redact(content);
  return {
    truncated: content.length > maxChars,
    true_length: content.length,
    content: content.slice(0, maxChars),
  };
}
