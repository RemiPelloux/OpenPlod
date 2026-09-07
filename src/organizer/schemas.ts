import { z } from 'zod';

export const identifier = z.string().uuid();
export const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const noteTitle = z.string().trim().min(1).max(180).refine(value => !/[\x00-\x1f/\\]/.test(value), 'Use a title without path separators or control characters');
export const markdown = z.string().max(524288).refine(value => !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= 524288, 'Markdown must be UTF-8 text up to 512 KB');
export const createFolderSchema = z.object({ name: noteTitle, parentId: identifier.nullable().default(null) }).strict();
export const updateFolderSchema = z.object({ name: noteTitle.optional(), parentId: identifier.nullable().optional(), revision }).strict();
export const createNoteSchema = z.object({ title: noteTitle, content: markdown.default(''), folderId: identifier.nullable().default(null), idempotencyKey: identifier }).strict();
export const updateNoteSchema = z.object({ title: noteTitle.optional(), content: markdown.optional(), folderId: identifier.nullable().optional(), starred: z.boolean().optional(), revision }).strict();
export const snapshotSchema = z.object({ recordingId: identifier, versionId: identifier.nullable().optional(), folderId: identifier.nullable().default(null), title: noteTitle.optional() }).strict();
export const noteListSchema = z.object({
  folderId: z.union([identifier, z.literal('inbox')]).optional(),
  view: z.enum(['all', 'starred', 'trash']).default('all'), q: z.string().trim().max(200).default(''),
  sort: z.enum(['updated', 'title']).default('updated'),
  offset: z.coerce.number().int().min(0).max(1000000).default(0), limit: z.coerce.number().int().min(1).max(100).default(30),
}).strict();
export const revisionSchema = z.object({ revision }).strict();
export const purgeSchema = z.object({ revision, confirm: z.literal(true) }).strict();
export const sendNoteSchema = z.object({ destinationId: z.string().regex(/^[a-z0-9-]{1,64}$/), revision, confirm: z.literal(true), idempotencyKey: identifier }).strict();
