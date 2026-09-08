export interface NoteFolder {
  id: string; name: string; parentId: string | null; revision: number; documentCount: number;
}

export interface NoteSummary {
  id: string; title: string; folderId: string | null; starred: boolean; revision: number;
  excerpt: string; createdAt: string; updatedAt: string; deletedAt: string | null;
  sourceRecordingId: string | null; sourceVersionId: string | null; sourceOrigin: string | null;
}

export interface NoteDocument extends NoteSummary { content: string }
export interface DocumentGeneration {
  id: string; recordingId: string; versionId: string | null; state: 'pending' | 'ready' | 'failed';
  provider: 'mistral' | 'openai' | 'anthropic' | 'ollama'; model: string; title: string; content: string | null;
  createdAt: string; documentId: string | null; steps: { stage: string; at: string }[];
}
export interface NoteVersion { id: string; revision: number; title: string; content: string; createdAt: string }
export interface NotePage { documents: NoteSummary[]; total: number; offset: number; limit: number }
export interface NoteDestination { id: string; name: string; host: string }
export interface NoteDelivery {
  id: string; documentId: string; documentRevision: number; destinationId: string;
  state: 'pending' | 'sent' | 'unknown'; createdAt: string; statusCode: number | null;
}
