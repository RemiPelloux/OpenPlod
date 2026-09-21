import { describe, expect, test } from 'bun:test';
import {
  DOCUMENT_STYLES, documentTemplate, documentTemplateCatalog, isDocumentStyle,
} from './document-templates';

describe('template catalog', () => {
  test('covers every template the roadmap names for TS-07', () => {
    // meeting minutes, interview notes, lecture notes, project briefs, PRDs, follow-up emails
    expect(DOCUMENT_STYLES).toEqual(['notes', 'meeting', 'interview', 'lecture', 'brief', 'prd', 'email']);
  });

  test('keeps the three pre-existing styles so saved clients keep working', () => {
    for (const style of ['notes', 'meeting', 'brief'] as const) {
      expect(isDocumentStyle(style)).toBe(true);
    }
  });

  test('rejects an unknown style', () => {
    expect(isDocumentStyle('poem')).toBe(false);
    expect(isDocumentStyle('')).toBe(false);
  });

  test('every template has a label, description and instruction', () => {
    for (const style of DOCUMENT_STYLES) {
      const template = documentTemplate(style);
      expect(template.id).toBe(style);
      expect(template.label.length).toBeGreaterThan(0);
      expect(template.description.length).toBeGreaterThan(0);
      expect(template.instruction.length).toBeGreaterThan(20);
    }
  });

  test('the catalog omits prompt text so it can be sent to clients', () => {
    const catalog = documentTemplateCatalog();
    expect(catalog).toHaveLength(DOCUMENT_STYLES.length);
    for (const entry of catalog) expect(entry).not.toHaveProperty('instruction');
  });
});

describe('template constraints', () => {
  test('the shared generation prompt forbids invention for every template', async () => {
    // The blanket constraint lives once in the generation prompt rather than
    // being restated in each template, so assert it at its real home.
    const source = await Bun.file(new URL('./generation.ts', import.meta.url)).text();
    expect(source).toContain('Never invent facts, quotations, names, deadlines, decisions or assignments.');
  });

  test('templates that invite invention carry their own extra guard', () => {
    // "notes" is a neutral summary; these five each tempt a model to supply
    // a recipient, a metric, a quotation, a definition or an owner.
    for (const style of ['meeting', 'interview', 'lecture', 'prd', 'email'] as const) {
      const instruction = documentTemplate(style).instruction.toLowerCase();
      expect(instruction).toMatch(/do not invent|never state|only if the transcript|do not supply|quote only|record what was said|only where supported/);
    }
  });

  test('the email template refuses to invent a recipient or a commitment', () => {
    const instruction = documentTemplate('email').instruction.toLowerCase();
    expect(instruction).toContain('do not invent a recipient');
    expect(instruction).toMatch(/never state a commitment/);
    expect(instruction).toContain('draft');
  });

  test('the PRD template forbids invented metrics and dates', () => {
    expect(documentTemplate('prd').instruction.toLowerCase()).toContain('do not invent metrics, dates');
  });

  test('the interview template forbids paraphrasing inside quotation marks', () => {
    expect(documentTemplate('interview').instruction.toLowerCase())
      .toContain('do not paraphrase inside quotation marks');
  });

  test('the lecture template records what was said rather than correcting it', () => {
    expect(documentTemplate('lecture').instruction.toLowerCase()).toContain('record what was said');
  });
});

describe('output shape', () => {
  test('an email is prose, so it does not require section headings', () => {
    expect(documentTemplate('email').requiresSections).toBe(false);
  });

  test('every other template produces a sectioned document', () => {
    for (const style of DOCUMENT_STYLES.filter(value => value !== 'email')) {
      expect(documentTemplate(style).requiresSections).toBe(true);
    }
  });
});
