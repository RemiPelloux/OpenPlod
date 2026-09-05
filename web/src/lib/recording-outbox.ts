const DATABASE_NAME = 'openplod-mobile'
const STORE_NAME = 'recording-outbox'
const DATABASE_VERSION = 1

export interface PendingCapture {
  id: string
  blob: Blob
  filename: string
  title: string
  context: string
  recordedAt: string
  durationMs: number
  sourceProvider?: 'opennotes' | 'plaud' | 'upload'
  sourceTransport?: 'mobile' | 'upload'
  sourceRecordingId?: string
  nativeShareId?: string
}

export async function savePendingCapture(capture: PendingCapture): Promise<void> {
  const database = await openDatabase()
  await transactionPromise(database, 'readwrite', store => store.put(capture))
  database.close()
}

export async function latestPendingCapture(): Promise<PendingCapture | null> {
  const database = await openDatabase()
  const captures = await transactionPromise<PendingCapture[]>(database, 'readonly', store => store.getAll())
  database.close()
  return captures.slice().sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0] ?? null
}

export async function removePendingCapture(id: string): Promise<void> {
  const database = await openDatabase()
  await transactionPromise(database, 'readwrite', store => store.delete(id))
  database.close()
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open the recording outbox.'))
  })
}

function transactionPromise<T = void>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode)
    const request = operation(transaction.objectStore(STORE_NAME))
    request.onsuccess = () => resolve(request.result as T)
    request.onerror = () => reject(request.error ?? new Error('The recording outbox operation failed.'))
    transaction.onerror = () => reject(transaction.error ?? new Error('The recording outbox transaction failed.'))
  })
}
