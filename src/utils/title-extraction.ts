import { PluginSettings } from '../types';
import { t } from '../i18n';
import { escapeRegExp } from './file-exclusions';
import {
  renderInlineMarkup,
  opensHtmlBlock,
  InlineMarkupOptions,
} from './inline-markup';
import {
  splitBlockPrefixes,
  opensAtxHeading,
  isEmptyAtxHeading,
} from './block-prefixes';

/** True when Reading view renders the line as an ATX heading, an empty one (`#`) included. */
export function isValidHeading(line: string): boolean {
  return opensAtxHeading(line);
}

// Reading view's rendering of the line is the reference: every transform here aims to yield the text Reading view shows, and a divergence from it is a bug.
export function extractTitle(
  line: string,
  settings: PluginSettings,
  options?: { skipMarkupStripping?: boolean }
): string {
  const skipMarkupStripping = options?.skipMarkupStripping ?? false;
  const stripMarkupSettings = settings.markupStripping.stripMarkupSettings;
  // The one stripping gate: a toggle counts only while markup stripping is not skipped.
  const shouldStrip = (enabled: boolean): boolean =>
    !skipMarkupStripping && enabled;

  // Remove template placeholder if enabled
  if (shouldStrip(settings.markupStripping.stripTemplaterSyntax)) {
    const withoutCursor = line.replace(/<%\s*tp\.file\.cursor\(\)\s*%>/, '');
    if (withoutCursor !== line) {
      line = withoutCursor.trim();
    }
    if (line.trim() === '<%*') {
      return t('untitled');
    }
  }

  // An empty heading renders nothing whatever the toggles say, so this check is not gated on them.
  if (isEmptyAtxHeading(line)) {
    return t('untitled');
  }

  // Read from the whole line, as the block structure decides it whatever prefixes the toggles keep
  const htmlBlock = opensHtmlBlock(line);
  // A bare list marker leaves no content, which the final empty check turns into Untitled.
  const blockPrefixes = splitBlockPrefixes(line, {
    callouts: shouldStrip(stripMarkupSettings.callouts),
    quote: shouldStrip(stripMarkupSettings.quote),
    task: shouldStrip(stripMarkupSettings.taskLists),
    unordered: shouldStrip(stripMarkupSettings.unorderedLists),
    ordered: shouldStrip(stripMarkupSettings.orderedLists),
    headings: shouldStrip(stripMarkupSettings.headings),
  });

  // Code and a callout's default title are shown as typed, so no inline markup is read in them.
  if (blockPrefixes.raw) {
    const rawText = (blockPrefixes.keptPrefix + blockPrefixes.content).trim();
    return rawText === '' ? t('untitled') : applyTitleCase(rawText, settings);
  }
  // Leading whitespace stays until here, since it decides indented code; trailing whitespace never changes how a line renders.
  line = blockPrefixes.content.trimEnd();

  // Text the tokenizer shows as typed (escapes, decoded character references, code spans, math, links, wikilinks, tags, and the HTML and footnotes a toggle keeps) waits behind placeholders until the edges are trimmed, so it keeps the spaces it shows; every other backslash stays in the line for `processForbiddenChars` to replace or drop.
  const protectedTexts = new Map<string, string>();
  let placeholderCounter = 0;

  // Check for placeholder collision (extremely rare - user would need to type exact Unicode chars)
  const hasPlaceholderCollision = line.includes('⸢FLITESC');
  const protect = (text: string): string => {
    if (hasPlaceholderCollision || text === '') return text;
    const placeholder = `⸢FLITESC${placeholderCounter++}⸥`;
    protectedTexts.set(placeholder, text);
    return placeholder;
  };

  // Inline markup is parsed even when stripping is skipped, so escapes resolve the same way and every construct keeps its delimiters.
  // Comment toggles cover Obsidian's %%…%% only — HTML comments are stripped by the htmlTags toggle instead.
  // Settings hides "Strip comments entirely" under "Strip comment markup", so it counts only while that is on.
  let commentHandling: InlineMarkupOptions['comments'] = 'keep';
  if (shouldStrip(stripMarkupSettings.comments)) {
    commentHandling = settings.markupStripping.stripCommentsEntirely
      ? 'remove'
      : 'unwrap';
  }
  // Whatever a stripped construct leaves at either edge never shows in Reading view, so it is trimmed.
  line = (
    blockPrefixes.keptPrefix +
    renderInlineMarkup(line, {
      bold: shouldStrip(stripMarkupSettings.bold),
      italic: shouldStrip(stripMarkupSettings.italic),
      strikethrough: shouldStrip(stripMarkupSettings.strikethrough),
      highlight: shouldStrip(stripMarkupSettings.highlight),
      code: shouldStrip(stripMarkupSettings.code),
      wikilinks: shouldStrip(stripMarkupSettings.wikilinks),
      links: shouldStrip(stripMarkupSettings.markdownLinks),
      html: shouldStrip(stripMarkupSettings.htmlTags),
      footnotes: shouldStrip(stripMarkupSettings.footnotes),
      math: shouldStrip(settings.markupStripping.stripInlineMathMarkup),
      comments: commentHandling,
      protect,
      htmlBlock,
    })
  ).trim();

  // Restore protected text - only if any was protected
  if (protectedTexts.size > 0) {
    // Build regex for efficient single-pass restoration
    const pattern = new RegExp(
      Array.from(protectedTexts.keys()).join('|'),
      'g'
    );
    line = line.replace(pattern, (match) => protectedTexts.get(match) ?? match);
  }

  // Final check: if line is empty or only whitespace after all processing
  if (line.trim() === '') {
    return t('untitled');
  }

  return applyTitleCase(line, settings);
}

/** Apply the title case setting, the last step of every title, code shown as typed included. */
export function applyTitleCase(text: string, settings: PluginSettings): string {
  switch (settings.core.titleCase) {
    case 'uppercase':
      return text.toUpperCase();
    case 'lowercase':
      return text.toLowerCase();
    default:
      // "preserve" - no change
      return text;
  }
}

/**
 * True for the localized "Untitled", alone or followed by whitespace and a number without a leading zero: the shape of the names Obsidian gives new notes.
 * @param name - Note name or title text, without its extension
 */
export function isUntitledName(name: string): boolean {
  return new RegExp(`^${escapeRegExp(t('untitled'))}(\\s+[1-9]\\d*)?$`).test(
    name
  );
}
