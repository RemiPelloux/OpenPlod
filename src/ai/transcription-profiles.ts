import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import { speechProviders, type AiConfig, type SpeechProvider } from './config';
import { omitsTranscriptionHints, speechCapabilities, validateSpeechOptions } from './capabilities';

/**
 * Transcription profiles: a named context prompt, vocabulary, and optional
 * provider/model/language for one kind of recording ("Medical consultation",
 * "Engineering standup"). A profile is a provider *hint*, never a rewrite of
 * the transcript: it only changes what is sent with the audio.
 */
const model = z.string().trim().max(120).regex(/^[a-zA-Z0-9_.:/-]*$/);
export const profilePrompt = z.string().trim().max(1000);
export const profileVocabulary = z.array(z.string().trim().min(1).max(80)).max(100);
const language = z.string().regex(/^(auto|[a-z]{2,3}(-[A-Z]{2})?)$/);
export const profileInput = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).default(''),
  engine: z.enum(speechProviders).nullable().default(null),
  model: model.nullable().default(null),
  language: language.nullable().default(null),
  diarize: z.boolean().nullable().default(null),
  prompt: profilePrompt.default(''),
  vocabulary: profileVocabulary.default([]),
}).strict();
export const createProfileSchema = z.union([z.object({ preset: z.string().regex(/^[a-z-]{1,40}$/), name: z.string().trim().min(1).max(80).optional() }).strict(), profileInput]);
export const updateProfileSchema = profileInput.partial().strict();
export type ProfileInput = z.infer<typeof profileInput>;
export interface TranscriptionProfile extends ProfileInput { id: string; createdAt: string; updatedAt: string }
export interface ProfilePreset extends ProfileInput { id: string }

export class ProfileError extends Error { constructor(public status: 400 | 404 | 409, message: string) { super(message); } }

/** Starting points only: creating a profile from a preset copies it, so later preset changes never alter a saved profile. */
export const PROFILE_PRESETS: ProfilePreset[] = [
  { id: 'meeting', name: 'Team meeting', description: 'Colleagues discussing projects, decisions, and next steps.', engine: null, model: null, language: null, diarize: true,
    prompt: 'A business meeting between colleagues. It mentions people, project names, dates, decisions, and action items.', vocabulary: [] },
  { id: 'reunion-fr', name: 'Réunion (français)', description: 'Réunion de travail en français, noms propres et décisions.', engine: null, model: null, language: 'fr', diarize: true,
    prompt: 'Réunion de travail en français entre collègues : projets, décisions, échéances et actions à mener.', vocabulary: [] },
  { id: 'medical', name: 'Medical consultation', description: 'Clinician and patient; drug names, dosages, and clinical terms.', engine: null, model: null, language: null, diarize: true,
    prompt: 'A medical consultation between a clinician and a patient. It uses clinical terminology, drug names, dosages in mg, and anatomical terms.', vocabulary: [] },
  { id: 'legal', name: 'Legal discussion', description: 'Case names, statutes, clauses, and parties spelled exactly.', engine: null, model: null, language: null, diarize: true,
    prompt: 'A legal discussion. It refers to parties, case names, statutes, contract clauses, and section numbers.', vocabulary: [] },
  { id: 'lecture', name: 'Lecture or class', description: 'One main speaker teaching technical material.', engine: null, model: null, language: null, diarize: false,
    prompt: 'A university lecture by one speaker. It contains technical vocabulary, definitions, formulas, and references to authors.', vocabulary: [] },
  { id: 'interview', name: 'Interview or podcast', description: 'Two or more voices in a question-and-answer conversation.', engine: null, model: null, language: null, diarize: true,
    prompt: 'An interview between a host and a guest, alternating questions and answers.', vocabulary: [] },
  { id: 'engineering', name: 'Engineering standup', description: 'Software terms, product names, and acronyms.', engine: null, model: null, language: null, diarize: true,
    prompt: 'A software engineering discussion about code, pull requests, deployments, APIs, databases, and incidents.',
    vocabulary: ['API', 'CI/CD', 'pull request', 'Kubernetes', 'TypeScript', 'PostgreSQL', 'SQLite', 'MCP'] },
  { id: 'sales', name: 'Customer call', description: 'Sales or support call with a customer.', engine: null, model: null, language: null, diarize: true,
    prompt: 'A call between a company representative and a customer about pricing, contracts, product features, and follow-up steps.', vocabulary: [] },
];

type Row = { id: string; name: string; description: string; engine: string | null; model: string | null; language: string | null; diarize: number | null; prompt: string; vocabulary: string; createdAt: string; updatedAt: string };
const columns = `id, name, description, engine, model, language, diarize, prompt, vocabulary, created_at AS createdAt, updated_at AS updatedAt`;
const fromRow = (row: Row): TranscriptionProfile => ({ ...row, engine: row.engine as SpeechProvider | null, diarize: row.diarize === null ? null : row.diarize === 1, vocabulary: JSON.parse(row.vocabulary) });

export function initializeTranscriptionProfiles(database: Database) {
  database.exec(`CREATE TABLE IF NOT EXISTS transcription_profiles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', engine TEXT, model TEXT, language TEXT, diarize INTEGER,
    prompt TEXT NOT NULL DEFAULT '', vocabulary TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS transcription_profiles_name ON transcription_profiles(name COLLATE NOCASE);`);
}

/** A model only belongs to the engine it was chosen for; reject combinations that would fail at run time. */
function checkCombination(profile: ProfileInput) {
  if (profile.model && !profile.engine) throw new ProfileError(400, 'Choose a provider before choosing a model.');
  if (profile.engine) {
    try { validateSpeechOptions(profile.engine, { model: profile.model ?? undefined, diarize: profile.diarize ?? undefined, vocabulary: profile.vocabulary, prompt: profile.prompt, language: profile.language ?? undefined }); }
    catch (error) { throw new ProfileError(400, (error as Error).message); }
  }
}

export class TranscriptionProfiles {
  constructor(readonly database: Database) { initializeTranscriptionProfiles(database); }
  list(): TranscriptionProfile[] {
    return (this.database.query(`SELECT ${columns} FROM transcription_profiles ORDER BY name COLLATE NOCASE`).all() as Row[]).map(fromRow);
  }
  get(id: string): TranscriptionProfile {
    const row = this.database.query(`SELECT ${columns} FROM transcription_profiles WHERE id=?`).get(id) as Row | null;
    if (!row) throw new ProfileError(404, 'Transcription profile not found.');
    return fromRow(row);
  }
  create(input: unknown): TranscriptionProfile {
    const parsed = createProfileSchema.parse(input);
    let data: ProfileInput;
    if ('preset' in parsed) {
      const preset = PROFILE_PRESETS.find(item => item.id === parsed.preset);
      if (!preset) throw new ProfileError(404, 'Unknown profile preset.');
      const { id: _id, ...fields } = preset;
      data = { ...fields, name: parsed.name ?? this.freeName(preset.name) };
    } else data = parsed;
    checkCombination(data);
    const id = crypto.randomUUID(), now = new Date().toISOString();
    try {
      this.database.query(`INSERT INTO transcription_profiles(id,name,description,engine,model,language,diarize,prompt,vocabulary,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, data.name, data.description, data.engine, data.model || null, data.language, data.diarize === null ? null : Number(data.diarize), data.prompt, JSON.stringify(dedupe(data.vocabulary)), now, now);
    } catch (error) { throw this.unique(error); }
    return this.get(id);
  }
  update(id: string, input: unknown): TranscriptionProfile {
    const current = this.get(id), patch = updateProfileSchema.parse(input);
    const next: ProfileInput = { ...current, ...patch };
    // Changing the provider drops a model chosen for the previous one.
    if (patch.engine !== undefined && patch.engine !== current.engine && patch.model === undefined) next.model = null;
    checkCombination(next);
    try {
      this.database.query(`UPDATE transcription_profiles SET name=?,description=?,engine=?,model=?,language=?,diarize=?,prompt=?,vocabulary=?,updated_at=? WHERE id=?`)
        .run(next.name, next.description, next.engine, next.model || null, next.language, next.diarize === null ? null : Number(next.diarize), next.prompt, JSON.stringify(dedupe(next.vocabulary)), new Date().toISOString(), id);
    } catch (error) { throw this.unique(error); }
    return this.get(id);
  }
  delete(id: string) {
    this.get(id);
    this.database.transaction(() => {
      this.database.query('DELETE FROM transcription_profiles WHERE id=?').run(id);
      // A deleted default profile must not leave the vault pointing at nothing.
      const row = this.database.query("SELECT value FROM user_settings WHERE key='aiConfig'").get() as { value: string } | null;
      if (row) {
        const config = JSON.parse(row.value);
        if (config.transcriptionProfile === id) this.database.query("UPDATE user_settings SET value=? WHERE key='aiConfig'").run(JSON.stringify({ ...config, transcriptionProfile: '' }));
      }
    })();
  }
  private freeName(base: string) {
    const taken = new Set(this.list().map(item => item.name.toLowerCase()));
    for (let index = 1; ; index++) { const name = index === 1 ? base : `${base} (${index})`; if (!taken.has(name.toLowerCase())) return name; }
  }
  private unique(error: unknown) {
    return error instanceof Error && /UNIQUE/.test(error.message) ? new ProfileError(409, 'A profile with this name already exists.') : error;
  }
}

const dedupe = (terms: string[]) => [...new Map(terms.map(term => [term.toLowerCase(), term])).values()].slice(0, 100);

export interface EffectiveTranscription {
  config: AiConfig;
  options: { model?: string; language: string; diarize: boolean; vocabulary: string[]; prompt?: string };
  profile: { id: string; name: string } | null;
  /** Hints the selected transcription mode did not send. */
  ignored: string[];
}

/**
 * Resolve the settings a job actually runs with. The profile's provider and model
 * win when set; its prompt is joined after the one-off prompt; vocabularies merge.
 */
export function effectiveTranscription(database: Database, config: AiConfig): EffectiveTranscription {
  let profile: TranscriptionProfile | null = null;
  if (config.transcriptionProfile) {
    initializeTranscriptionProfiles(database);
    const row = database.query(`SELECT ${columns} FROM transcription_profiles WHERE id=?`).get(config.transcriptionProfile) as Row | null;
    if (!row) throw new ProfileError(404, 'The selected transcription profile no longer exists. Choose another one in AI settings.');
    profile = fromRow(row);
  }
  const engine = profile?.engine ?? config.transcriptionEngine, capabilities = speechCapabilities[engine];
  // A profile written for any provider carries hints some providers cannot take. Those are
  // left out and listed in `ignored`, so provenance says what was not sent. Hints the user
  // set directly on the job or in settings still fail loudly when unsupported.
  const ignored: string[] = [];
  const keep = <T>(value: T, supported: boolean, name: string, present: boolean): T | null => {
    if (!present || supported || profile?.engine) return value;
    ignored.push(name); return null;
  };
  const profileVocabulary = keep(profile?.vocabulary ?? [], capabilities.vocabulary, 'vocabulary', Boolean(profile?.vocabulary.length)) ?? [];
  const profilePromptText = keep(profile?.prompt ?? '', capabilities.prompt, 'prompt', Boolean(profile?.prompt)) ?? '';
  const profileDiarize = keep(profile?.diarize ?? null, capabilities.diarization, 'speaker labels', profile?.diarize === true);
  const effective: AiConfig = {
    ...config, transcriptionEngine: engine,
    transcriptionModel: profile?.engine ? profile.model ?? '' : engine === config.transcriptionEngine ? config.transcriptionModel : '',
    transcriptionLanguage: profile?.language ?? config.transcriptionLanguage,
    transcriptionDiarize: profile && profile.diarize !== null ? Boolean(profileDiarize) : config.transcriptionDiarize,
    transcriptionVocabulary: dedupe([...config.transcriptionVocabulary, ...profileVocabulary]),
    transcriptionPrompt: [config.transcriptionPrompt, profilePromptText].filter(Boolean).join('\n').slice(0, 2000),
  };
  if (omitsTranscriptionHints(engine, effective.transcriptionDiarize)) {
    if (effective.transcriptionVocabulary.length) ignored.push('vocabulary');
    if (effective.transcriptionPrompt.trim()) ignored.push('prompt');
    effective.transcriptionVocabulary = [];
    effective.transcriptionPrompt = '';
  }
  return {
    config: effective,
    options: { model: effective.transcriptionModel || undefined, language: effective.transcriptionLanguage, diarize: effective.transcriptionDiarize,
      vocabulary: effective.transcriptionVocabulary, ...(effective.transcriptionPrompt ? { prompt: effective.transcriptionPrompt } : {}) },
    profile: profile ? { id: profile.id, name: profile.name } : null,
    ignored,
  };
}

export function validateEffective(database: Database, config: AiConfig) {
  const resolved = effectiveTranscription(database, config);
  validateSpeechOptions(resolved.config.transcriptionEngine, resolved.options);
  return resolved;
}
