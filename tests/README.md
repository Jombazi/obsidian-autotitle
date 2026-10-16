# Test suite

## Structure

```
tests/
├── README.md                  # This file
├── mockObsidian.ts             # Mock implementation of Obsidian API
├── setup.ts                    # Test environment setup
├── testUtils.ts                # Helper functions for tests
├── jsdom.d.ts                  # DOM environment type augmentations
├── constants.test.ts
├── i18n.test.ts
├── locale-parity.test.ts
├── main.test.ts
├── modals.test.ts
├── notice-copy.test.ts
├── readme-locale-parity.test.ts
├── suggests.test.ts
├── testUtils.test.ts
├── utils.test.ts
├── version-bump.test.ts
├── core/                       # Core module tests
│   ├── cache-manager.test.ts
│   ├── command-registrar.test.ts
│   ├── disable-property-transition.test.ts
│   ├── editor-lifecycle-creation-window.test.ts
│   ├── editor-lifecycle-first-line.test.ts
│   ├── editor-lifecycle-linked-delay.test.ts
│   ├── editor-lifecycle-syncing-guard.test.ts
│   ├── event-handler-manager.test.ts
│   ├── file-creation-coordinator.test.ts
│   ├── file-state-manager.test.ts
│   ├── first-line-property-manager.test.ts
│   ├── first-line-property-properties-only-skip.test.ts
│   ├── link-manager.test.ts
│   ├── plugin-initializer.test.ts
│   ├── property-manager.test.ts
│   ├── rate-limiter.test.ts
│   ├── rename-engine.test.ts
│   ├── templater-integration.test.ts
│   ├── workspace-integration-creation-flow.test.ts
│   └── workspace-integration.test.ts
├── fixtures/                   # Frozen copies the tests compare against
│   └── inline-markup-reference.ts
├── modals/                     # Dialog tests
│   ├── entry-edit-modal.test.ts
│   ├── exclusion-entry-modal.test.ts
│   ├── focus-restore.test.ts
│   ├── form-sheet-header.test.ts
│   └── settings-transfer-modals.test.ts
├── operations/                 # Batch operation tests
│   ├── file-operations-title-insertion.test.ts
│   ├── file-operations.test.ts
│   ├── folder-operations.test.ts
│   └── tag-operations.test.ts
├── settings/                   # Settings tab tests
│   ├── character-replacements.test.ts
│   ├── custom-replacements.test.ts
│   ├── excluded-files.test.ts
│   ├── exclusion-list-notes.test.ts
│   ├── exclusion-row-delete.test.ts
│   ├── exclusion-row-edit.test.ts
│   ├── exclusions-add-item.test.ts
│   ├── first-line-property.test.ts
│   ├── general.test.ts
│   ├── import-guard.test.ts
│   ├── other.test.ts
│   ├── plugin-links.test.ts
│   ├── settings-base.test.ts
│   ├── settings-main.test.ts
│   ├── settings-paths.test.ts
│   └── transfer.test.ts
├── ui/                         # Context menu and property visibility tests
│   ├── context-menus.test.ts
│   ├── menu-config.test.ts
│   ├── menu-definitions.test.ts
│   └── property-visibility.test.ts
└── utils/                      # Utility module tests
    ├── content-reader.test.ts
    ├── custom-replacement-rules.test.ts
    ├── deep-merge.test.ts
    ├── embedded-editors.test.ts
    ├── exclusion-pattern.test.ts
    ├── file-exclusions.test.ts
    ├── first-line-property-keys.test.ts
    ├── frontmatter-edit.test.ts
    ├── inbound-links.test.ts
    ├── inline-markup.test.ts
    ├── property-value.test.ts
    ├── string-processing.test.ts
    ├── tag-detection.test.ts
    ├── tag-utils.test.ts
    └── title-source.test.ts
```

## Running tests

```bash
npm test                                    # all tests
npm run test:watch                          # watch mode
npm run test:coverage                       # with coverage
npm test -- string-processing.test.ts       # specific file
npm test -- -t "should handle forbidden"    # pattern match
npm test -- --reporter=verbose              # verbose output
```

### CI/CD

Tests run automatically on push via GitHub Actions (Node 20).

---

## Coverage

### Core modules

| Module        | Tests | Coverage                                                                                           |
| ------------- | ----- | -------------------------------------------------------------------------------------------------- |
| Rename Engine | 136   | Rate limiting, title source and heading gate, title extraction, refusal reasons and their notices, manual rename notices, first line property target, editor change processing |
| Cache Manager | 15    | Body-presence record, path reservation, rename and delete bookkeeping                              |
| Rate Limiter  | 44    | Per-key/global limits, time windows, expiration, purging expired keys, performance                 |
| i18n          | 74    | Locale switching, translations, variable replacement, English/Russian plurals                      |

### Utility modules

| Module            | Tests | Coverage                                                                       |
| ----------------- | ----- | ------------------------------------------------------------------------------ |
| String Processing | 55    | Forbidden chars, replacements and their reversal, line breaks, safe links, maxLength |
| File Exclusions   | 151   | Excluded files (paths, regular expressions), tags (frontmatter, inline and typed into the first line, regular expressions), properties (regular expression names and values), strategies |
| Tag Utilities     | 32    | Normalization, tag and excluded-tag entry keys, duplicate tag entries, child tag matching |
| Custom Replacement Rules | 11 | Whole-line, start-of-line and everywhere rules, literal `$&`, duplicate rule keys |
| Content Reader    | 27    | All read strategies (Editor/Cache/File), workspace search, page preview and Canvas card lookup |
| Core Utilities    | 583   | Logging, headings, title extraction and its Reading view parity (HTML-block lines included), exclusion list normalization, disable properties, replacement reversal |
| Inline Markup     | 420   | Equivalence with the pre-cache tokenizer on seeded inputs, linear time on pathological 100 KB lines, link destinations, block IDs, inline tags, HTML-block lines, hidden elements resolved after rendering, elements hidden by CSS, attributes or element semantics, SVG and MathML content |
| Title Source      | 440   | Line reads, properties boundary, title-source rules (code, fences, math, rules, comments, definitions, tables), indexed tags, Reading view parity |

**Total: 3546 tests across 74 files** (`npx vitest run`)

---

## Writing tests

### Basic structure

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { functionToTest } from '../src/module';
import { createTestSettings } from './testUtils';

describe('module-name', () => {
  let settings: PluginSettings;

  beforeEach(() => {
    settings = createTestSettings();
  });

  it('should do something', () => {
    const result = functionToTest('input', settings);
    expect(result).toBe('expected');
  });
});
```

### Using mock Obsidian API

```typescript
import { TFile, App } from './mockObsidian';
import { createMockFile, createMockApp } from './testUtils';

const file = createMockFile('test.md');
const app = createMockApp();

// Mock vault methods
app.vault.read = vi.fn().mockResolvedValue('file content');
app.vault.rename = vi.fn().mockResolvedValue(undefined);

// Mock metadata cache
app.metadataCache.getFileCache = vi.fn().mockReturnValue({
  frontmatter: { tags: ['test'] },
});
```

### Async functions

```typescript
it('should handle async operations', async () => {
  app.vault.read = vi.fn().mockResolvedValue('content');
  const result = await readFileContent(plugin, file);
  expect(result).toBe('content');
});
```

### Error handling

```typescript
it('should handle errors', async () => {
  app.vault.read = vi.fn().mockRejectedValue(new Error('Read failed'));
  await expect(readFileContent(plugin, file)).rejects.toThrow('Read failed');
});
```

---

## Test utilities

### `createTestSettings(overrides?)`

```typescript
const settings = createTestSettings({
  core: { renameAutomatically: false },
});
```

### `createMockFile(path)`

```typescript
const file = createMockFile('folder/note.md');
// file.path = 'folder/note.md'
// file.basename = 'note'
// file.extension = 'md'
```

### `createMockApp()`

```typescript
const app = createMockApp();
// Includes vault, metadataCache, workspace, fileManager
```

### `createMockFolder(path)`

```typescript
const folder = createMockFolder('Notes');
```

### `stubEditorText(editor, text)`

```typescript
const editor = new Editor();
stubEditorText(editor, '# Title\nBody');
// getValue, lineCount and getLine all read the same text, as the title walk reads an editor line by line
```

### `splitFrontMatter(content)`

A port of Obsidian's `getFrontMatterInfo`, and the mock's default implementation of it, so a fixture can hold raw note text with a properties block.

---

## Best practices

1. **Naming**: Use `.test.ts` suffix
2. **Descriptive names**: Clear `describe` and `it` descriptions
3. **Arrange-Act-Assert**: Setup, execution, verification
4. **Focused tests**: One assertion per test when possible
5. **Mock external deps**: Use mocks for Obsidian API
6. **Test edge cases**: Empty strings, null, undefined, errors
7. **Fresh state**: Use `beforeEach` for consistent test state

### Good test

```typescript
it('should replace slash with dash when enabled', () => {
  settings.replaceCharacters.charReplacements.slash.enabled = true;
  settings.replaceCharacters.charReplacements.slash.replacement = '-';

  const result = processForbiddenChars('hello/world', settings);

  expect(result).toBe('hello-world');
});
```

### Bad test

```typescript
it('should work', () => {
  const result = processForbiddenChars('hello/world', settings);
  expect(result).toBeTruthy(); // Too vague
});
```

---

## Common pitfalls

**Forgetting async/await**

```typescript
// Wrong
const result = readFileContent(plugin, file);

// Correct
const result = await readFileContent(plugin, file);
```

**Not mocking API calls**

```typescript
// Will fail - no mock
const cache = app.metadataCache.getFileCache(file);

// Correct
app.metadataCache.getFileCache = vi.fn().mockReturnValue({...});
```

**Shared state between tests**

```typescript
// Wrong - mutates shared object
let settings = createTestSettings();
it('test 1', () => {
  settings.core.renameAutomatically = false;
});
it('test 2', () => {
  /* settings is mutated */
});

// Correct - fresh state
let settings: PluginSettings;
beforeEach(() => {
  settings = createTestSettings();
});
```

---

## Resources

- [Vitest Documentation](https://vitest.dev/)
- [Obsidian API](https://github.com/obsidianmd/obsidian-api)
