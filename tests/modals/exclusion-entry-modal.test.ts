/**
 * Tests for the exclusion entry dialog on its own, with the fields and the
 * submit the Exclusions page lists hand it. The Excluded files dialog's
 * Obsidian replication is pinned in `excluded-files.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { App, displayTooltip } from '../mockObsidian';

const { openedModals } = vi.hoisted(() => ({
  openedModals: [] as unknown[],
}));

vi.mock('../../src/i18n', () => ({
  t: vi.fn((key: string) => key),
}));

vi.mock('../../src/modals/exclusion-entry-modal', async (importOriginal) => {
  const { withRecordedExclusionEntryModals } = await import('../testUtils');
  return withRecordedExclusionEntryModals(
    await importOriginal<
      typeof import('../../src/modals/exclusion-entry-modal')
    >(),
    openedModals
  );
});

import {
  ExclusionEntryModal,
  type ExclusionEntryField,
} from '../../src/modals/exclusion-entry-modal';
import {
  flush,
  openLatestExclusionEntryDialog,
  pressEnter,
  typeInto,
} from '../testUtils';

function openDialog(
  fields: ExclusionEntryField[],
  submitEntry: (values: string[]) => Promise<string | null> = vi
    .fn()
    .mockResolvedValue(null)
) {
  const onSubmitted = vi.fn();
  new ExclusionEntryModal(new App() as never, {
    title: 'Add property',
    fields,
    submitEntry,
    onSubmitted,
  });
  return {
    ...openLatestExclusionEntryDialog(openedModals),
    submitEntry: vi.mocked(submitEntry),
    onSubmitted,
  };
}

const NAME_AND_VALUE: ExclusionEntryField[] = [
  { label: 'Property name', help: 'Name help' },
  { label: 'Property value', help: 'Value help' },
];

describe('ExclusionEntryModal', () => {
  beforeEach(() => {
    openedModals.length = 0;
    vi.mocked(displayTooltip).mockClear();
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  describe('fields', () => {
    it('draws one labeled field per entry, each followed by its help line', () => {
      const { modal, labels, helps, inputs } = openDialog(NAME_AND_VALUE);

      expect(modal.setTitle).toHaveBeenCalledWith('Add property');
      expect(labels).toEqual(['Property name', 'Property value']);
      expect(helps).toEqual(['Name help', 'Value help']);
      expect(inputs.map((input) => input.spellcheck)).toEqual([false, false]);
    });

    it('leaves the label of a one-field dialog empty', () => {
      const { labels } = openDialog([{ label: '', help: 'Help' }]);

      expect(labels).toEqual(['']);
    });

    it('draws no help line for a field without help', () => {
      const { modal, labels } = openDialog([
        { label: 'Property name' },
        NAME_AND_VALUE[1],
      ]);

      expect(labels).toEqual(['Property name', 'Property value']);
      expect(
        Array.from(
          modal.contentEl.querySelectorAll('p.form-field'),
          (fieldEl) => fieldEl.querySelector('.form-field-help')?.textContent
        )
      ).toEqual([undefined, 'Value help']);
    });

    it('prefills each field from its initial value', () => {
      const { inputs } = openDialog([
        { ...NAME_AND_VALUE[0], initialValue: 'status' },
        NAME_AND_VALUE[1],
      ]);

      expect(inputs.map((input) => input.value)).toEqual(['status', '']);
    });
  });

  describe('submitting', () => {
    it('hands over the trimmed values in field order, then closes and reports the submit', async () => {
      const { modal, inputs, doneButton, submitEntry, onSubmitted } =
        openDialog(NAME_AND_VALUE);

      inputs[0].value = '  status ';
      inputs[1].value = ' done';
      doneButton.click();
      await flush();

      expect(submitEntry).toHaveBeenCalledWith(['status', 'done']);
      expect(modal.close).toHaveBeenCalledTimes(1);
      expect(onSubmitted).toHaveBeenCalledTimes(1);
    });

    it('submits on Enter in any field', async () => {
      const { inputs, submitEntry } = openDialog(NAME_AND_VALUE);

      inputs[0].value = 'status';
      pressEnter(inputs[1]);
      await flush();

      expect(submitEntry).toHaveBeenCalledWith(['status', '']);
    });

    it('shows the error on the first field and stays open, whichever field caused it', async () => {
      const { modal, inputs, doneButton, onSubmitted } = openDialog(
        NAME_AND_VALUE,
        vi.fn().mockResolvedValue('Already in the list')
      );

      doneButton.click();
      await flush();

      expect(displayTooltip).toHaveBeenCalledWith(
        inputs[0],
        'Already in the list',
        { classes: ['mod-error'] }
      );
      expect(modal.close).not.toHaveBeenCalled();
      expect(onSubmitted).not.toHaveBeenCalled();
    });

    it('submits again after an error', async () => {
      const submitEntry = vi
        .fn()
        .mockResolvedValueOnce('Property name cannot be empty')
        .mockResolvedValueOnce(null);
      const { modal, inputs, doneButton } = openDialog(
        NAME_AND_VALUE,
        submitEntry
      );

      doneButton.click();
      await flush();
      inputs[0].value = 'status';
      doneButton.click();
      await flush();

      expect(submitEntry).toHaveBeenCalledTimes(2);
      expect(modal.close).toHaveBeenCalledTimes(1);
    });

    it('submits once when Enter repeats before the save settles, showing no error for the entry it just recorded', async () => {
      let settleSave: (error: string | null) => void = () => {};
      const submitEntry = vi.fn(
        () =>
          new Promise<string | null>((resolve) => {
            settleSave = resolve;
          })
      );
      const { modal, inputs } = openDialog(NAME_AND_VALUE, submitEntry);

      inputs[0].value = 'status';
      pressEnter(inputs[0]);
      pressEnter(inputs[0]);
      settleSave(null);
      await flush();
      pressEnter(inputs[0]);
      await flush();

      expect(submitEntry).toHaveBeenCalledTimes(1);
      expect(displayTooltip).not.toHaveBeenCalled();
      expect(modal.close).toHaveBeenCalledTimes(1);
    });
  });

  describe('suggesters', () => {
    it("attaches an empty field's suggester at once, and a prefilled field's only once it is typed into", () => {
      const attachToEmpty = vi.fn();
      const attachToPrefilled = vi.fn();
      const { inputs } = openDialog([
        { ...NAME_AND_VALUE[0], attachSuggest: attachToEmpty },
        {
          ...NAME_AND_VALUE[1],
          initialValue: 'done',
          attachSuggest: attachToPrefilled,
        },
      ]);
      const reopenedQueries: string[] = [];
      inputs[1].addEventListener('input', () =>
        reopenedQueries.push(inputs[1].value)
      );

      expect(attachToEmpty).toHaveBeenCalledWith(
        inputs[0],
        expect.any(Function)
      );
      expect(attachToPrefilled).not.toHaveBeenCalled();

      typeInto(inputs[1], 'don');
      typeInto(inputs[1], 'do');

      expect(attachToPrefilled).toHaveBeenCalledTimes(1);
      expect(attachToPrefilled).toHaveBeenCalledWith(
        inputs[1],
        expect.any(Function)
      );
      // The first keystroke is re-dispatched so the new suggester opens on it
      expect(reopenedQueries).toEqual(['don', 'don', 'do']);
    });

    it('submits a pick with the picked text in its own field and the other fields as typed', async () => {
      let submitPick: (value: string) => void = () => {};
      const { inputs, submitEntry } = openDialog([
        { ...NAME_AND_VALUE[0] },
        {
          ...NAME_AND_VALUE[1],
          attachSuggest: (_inputEl, pick) => {
            submitPick = pick;
          },
        },
      ]);

      inputs[0].value = ' status ';
      inputs[1].value = 'do';
      submitPick('done');
      await flush();

      expect(submitEntry).toHaveBeenCalledWith(['status', 'done']);
    });
  });
});
