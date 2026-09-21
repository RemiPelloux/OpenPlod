/**
 * Document templates for transcript-derived documents (roadmap TS-07).
 *
 * Each template is an instruction added to the shared generation prompt. They
 * live here rather than inline in the service so the set can be extended and
 * asserted on, and so the shared constraint every one of them inherits is
 * visible in one place: a template describes *what sections to look for*, never
 * permission to supply content the transcript does not contain.
 *
 * The follow-up email template is the one with teeth: a model asked for an
 * email will happily invent a recipient, a commitment and a deadline. It is
 * therefore told to draft a body only, leave unknown recipients out, and never
 * state a commitment the transcript does not contain.
 */

export interface DocumentTemplate {
  id: DocumentStyle;
  /** Shown in the picker. */
  label: string;
  /** One line describing when to use it. */
  description: string;
  /** Appended to the generation system prompt. */
  instruction: string;
  /**
   * Some outputs are not section-structured documents. The generator requires
   * an H2 by default; a template can opt out where that would be wrong.
   */
  requiresSections: boolean;
}

export const DOCUMENT_STYLES = [
  'notes', 'meeting', 'interview', 'lecture', 'brief', 'prd', 'email',
] as const;
export type DocumentStyle = (typeof DOCUMENT_STYLES)[number];

export const isDocumentStyle = (value: string): value is DocumentStyle =>
  (DOCUMENT_STYLES as readonly string[]).includes(value);

const TEMPLATES: Record<DocumentStyle, DocumentTemplate> = {
  notes: {
    id: 'notes',
    label: 'Structured notes',
    description: 'Overview, thematic headings and useful bullet points.',
    instruction: 'Create detailed, structured notes with an overview, thematic headings and useful bullet points.',
    requiresSections: true,
  },
  meeting: {
    id: 'meeting',
    label: 'Meeting minutes',
    description: 'Purpose, discussion by topic, decisions and action items.',
    instruction:
      'Create meeting minutes: purpose, discussion by topic, decisions, and action items, only where supported by the transcript. '
      + 'Attribute a decision or action only to someone the transcript names as taking it; otherwise leave the owner unstated.',
    requiresSections: true,
  },
  interview: {
    id: 'interview',
    label: 'Interview notes',
    description: 'Background, themes, notable quotations and follow-ups.',
    instruction:
      'Create interview notes: background, the themes discussed, notable verbatim quotations, and follow-up questions. '
      + 'Quote only wording that appears in the transcript, and mark a quotation as such. Do not paraphrase inside quotation marks. '
      + 'Distinguish the interviewer from the interviewee only when the transcript makes that clear.',
    requiresSections: true,
  },
  lecture: {
    id: 'lecture',
    label: 'Lecture notes',
    description: 'Topics, key concepts, definitions, examples and open points.',
    instruction:
      'Create lecture notes: the topics covered in order, key concepts with the definitions actually given, worked examples, '
      + 'and anything explicitly left open. Do not supply textbook definitions the speaker did not give, and do not correct '
      + 'the speaker; record what was said.',
    requiresSections: true,
  },
  brief: {
    id: 'brief',
    label: 'Project brief',
    description: 'Context, objectives, scope, requirements and next steps.',
    instruction:
      'Create a project brief: context, objectives, scope, requirements, open questions and next steps, '
      + 'only where supported by the transcript.',
    requiresSections: true,
  },
  prd: {
    id: 'prd',
    label: 'Product requirements',
    description: 'Problem, users, requirements, non-goals and open questions.',
    instruction:
      'Create a product requirements document: the problem, the users described, requirements, explicit non-goals, '
      + 'success measures, and open questions. Include a requirement only if the transcript states it. '
      + 'Do not invent metrics, dates, or numeric targets. Put anything discussed but undecided under open questions '
      + 'rather than writing it as a requirement.',
    requiresSections: true,
  },
  email: {
    id: 'email',
    label: 'Follow-up email',
    description: 'A draft recap email for the participants to review.',
    instruction:
      'Draft a short follow-up email recapping the conversation: what was discussed, what was decided, and what happens next. '
      + 'Write the email body only. Do not invent a recipient, a sender, a signature, or an email address; omit a salutation '
      + 'if the transcript does not name who is being written to. Never state a commitment, deadline or next step the '
      + 'transcript does not contain. This is a draft for the user to review and send themselves.',
    // An email is prose, not a document with H2 sections.
    requiresSections: false,
  },
};

export const documentTemplate = (style: DocumentStyle): DocumentTemplate => TEMPLATES[style];

/** Template metadata for the picker, without exposing prompt text to clients. */
export const documentTemplateCatalog = (): Omit<DocumentTemplate, 'instruction'>[] =>
  DOCUMENT_STYLES.map(style => {
    const { instruction: _instruction, ...rest } = TEMPLATES[style];
    return rest;
  });
