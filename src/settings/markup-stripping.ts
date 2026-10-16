import { SettingDefinitionItem, SettingDefinitionPage } from 'obsidian';
import { FirstLineIsTitlePlugin, quoteLabel } from './settings-base';
import { getPath, LeafPath, SettingPath } from './settings-paths';
import { MarkupStrippingSettings } from '../types';
import { t } from '../i18n';
import { createPluginLink, buildPluginLinkRouterGroup } from './plugin-links';

/** How a toggle's description reads. `example` fills a shared sentence under `settings.markupStripping.examples` with the toggle's code samples, its `example.markup`, `example.alternativeMarkup` and `example.result`; `standIn` quotes one of the top-level stand-in titles into the toggle's own `desc`; `sentence` is the toggle's own `desc` as is. */
type MarkupDescription =
  | { type: 'sentence' }
  | { type: 'example'; template: 'single' | 'withAlternative' }
  | { type: 'standIn'; standInKey: 'table' | 'mathBlock' | 'diagram' };

/** A markup-type toggle: `id` is the locale namespace under `settings.markupStripping.`, `path` the dot-path under `markupStripping.`. */
interface MarkupToggle {
  id: string;
  path: LeafPath<MarkupStrippingSettings>;
  description: MarkupDescription;
  /** Drawn directly below this toggle, and only while it is on. */
  subToggle?: MarkupToggle;
}

const SINGLE_EXAMPLE: MarkupDescription = {
  type: 'example',
  template: 'single',
};
const EXAMPLE_WITH_ALTERNATIVE: MarkupDescription = {
  type: 'example',
  template: 'withAlternative',
};
const SENTENCE: MarkupDescription = { type: 'sentence' };

/** Source order matters — it is the display order. */
const MARKUP_TOGGLES: MarkupToggle[] = [
  {
    id: 'headings',
    path: 'stripMarkupSettings.headings',
    description: SINGLE_EXAMPLE,
  },
  {
    id: 'bold',
    path: 'stripMarkupSettings.bold',
    description: EXAMPLE_WITH_ALTERNATIVE,
  },
  {
    id: 'italic',
    path: 'stripMarkupSettings.italic',
    description: EXAMPLE_WITH_ALTERNATIVE,
  },
  {
    id: 'strikethrough',
    path: 'stripMarkupSettings.strikethrough',
    description: SINGLE_EXAMPLE,
  },
  {
    id: 'highlight',
    path: 'stripMarkupSettings.highlight',
    description: SINGLE_EXAMPLE,
  },
  {
    id: 'wikilinks',
    path: 'stripMarkupSettings.wikilinks',
    description: EXAMPLE_WITH_ALTERNATIVE,
  },
  {
    id: 'markdownLinks',
    path: 'stripMarkupSettings.markdownLinks',
    description: SINGLE_EXAMPLE,
  },
  {
    id: 'quote',
    path: 'stripMarkupSettings.quote',
    description: SINGLE_EXAMPLE,
  },
  {
    id: 'callouts',
    path: 'stripMarkupSettings.callouts',
    description: SINGLE_EXAMPLE,
  },
  {
    id: 'unorderedLists',
    path: 'stripMarkupSettings.unorderedLists',
    description: EXAMPLE_WITH_ALTERNATIVE,
  },
  {
    id: 'orderedLists',
    path: 'stripMarkupSettings.orderedLists',
    description: SINGLE_EXAMPLE,
  },
  {
    id: 'taskLists',
    path: 'stripMarkupSettings.taskLists',
    description: SINGLE_EXAMPLE,
  },
  {
    id: 'stripHorizontalRuleMarkup',
    path: 'stripHorizontalRuleMarkup',
    description: SENTENCE,
  },
  { id: 'code', path: 'stripMarkupSettings.code', description: SINGLE_EXAMPLE },
  {
    id: 'codeBlocks',
    path: 'stripMarkupSettings.codeBlocks',
    description: SENTENCE,
    subToggle: {
      id: 'detectDiagrams',
      path: 'detectDiagrams',
      description: { type: 'standIn', standInKey: 'diagram' },
    },
  },
  {
    id: 'footnotes',
    path: 'stripMarkupSettings.footnotes',
    description: EXAMPLE_WITH_ALTERNATIVE,
  },
  {
    id: 'comments',
    path: 'stripMarkupSettings.comments',
    description: SINGLE_EXAMPLE,
    subToggle: {
      id: 'commentsEntirely',
      path: 'stripCommentsEntirely',
      description: SENTENCE,
    },
  },
  {
    id: 'stripTableMarkup',
    path: 'stripTableMarkup',
    description: { type: 'standIn', standInKey: 'table' },
  },
  {
    id: 'stripInlineMathMarkup',
    path: 'stripInlineMathMarkup',
    description: SINGLE_EXAMPLE,
  },
  {
    id: 'stripMathBlockMarkup',
    path: 'stripMathBlockMarkup',
    description: { type: 'standIn', standInKey: 'mathBlock' },
  },
  {
    id: 'htmlTags',
    path: 'stripMarkupSettings.htmlTags',
    description: SINGLE_EXAMPLE,
  },
];

/** Fills `template` with code samples: each `{{name}}` placeholder becomes `<code>` holding the sample `getSample(name)` returns. */
function buildCodeSampleSentence(
  template: string,
  getSample: (name: string) => string
): DocumentFragment {
  return createFragment((frag) => {
    // A capturing split alternates prose and placeholder names: even indexes are prose, odd ones names
    template.split(/\{\{(\w+)\}\}/).forEach((part, index) => {
      if (index % 2 === 1) {
        frag.createEl('code', { text: getSample(part) });
      } else if (part !== '') {
        frag.appendText(part);
      }
    });
  });
}

function buildMarkupDescription(
  toggle: MarkupToggle
): string | DocumentFragment {
  const namespace = `settings.markupStripping.${toggle.id}`;
  const { description } = toggle;
  switch (description.type) {
    case 'sentence':
      return t(`${namespace}.desc`);
    case 'standIn':
      // Read from the top-level stand-in title rather than a copy kept beside the description, so the two cannot drift apart
      return t(`${namespace}.desc`, {
        standIn: quoteLabel(t(description.standInKey)),
      });
    case 'example':
      return buildCodeSampleSentence(
        t(`settings.markupStripping.examples.${description.template}`),
        (name) => t(`${namespace}.example.${name}`)
      );
  }
}

function buildToggleDefinition(
  toggle: MarkupToggle,
  visible?: () => boolean
): SettingDefinitionItem<SettingPath> {
  const definition: SettingDefinitionItem<SettingPath> = {
    name: t(`settings.markupStripping.${toggle.id}.name`),
    desc: buildMarkupDescription(toggle),
    control: {
      type: 'toggle',
      key: `markupStripping.${toggle.path}`,
    },
  };
  return visible ? { ...definition, visible } : definition;
}

/** Description for the Templater toggle — a link plus an inline code sample. */
function buildTemplaterDescription(): DocumentFragment {
  return createFragment((frag) => {
    frag.appendText(t('settings.markupStripping.templater.desc.part1'));
    createPluginLink(frag, 'templater-obsidian', 'Templater');
    frag.appendText(t('settings.markupStripping.templater.desc.part2'));
    frag.createEl('code', {
      text: t('settings.markupStripping.templater.desc.code'),
    });
    frag.appendText(t('settings.markupStripping.templater.desc.part3'));
  });
}

export function buildMarkupStrippingPage(
  plugin: FirstLineIsTitlePlugin
): SettingDefinitionPage<SettingPath> {
  const items: SettingDefinitionItem<SettingPath>[] = [];

  for (const toggle of MARKUP_TOGGLES) {
    items.push(buildToggleDefinition(toggle));
    if (toggle.subToggle) {
      const parentPath = toggle.path;
      items.push(
        buildToggleDefinition(
          toggle.subToggle,
          () =>
            getPath(plugin.settings, `markupStripping.${parentPath}`) === true
        )
      );
    }
  }

  items.push({
    name: t('settings.markupStripping.templater.name'),
    desc: buildTemplaterDescription(),
    control: {
      type: 'toggle',
      key: 'markupStripping.stripTemplaterSyntax',
    },
  });

  items.push(buildPluginLinkRouterGroup(plugin.app));

  return {
    type: 'page',
    name: t('settings.sections.markupStripping'),
    desc: t('settings.markupStripping.desc'),
    items,
  };
}
