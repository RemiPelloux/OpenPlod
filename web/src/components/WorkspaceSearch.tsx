import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as Dialog from "@radix-ui/react-dialog";
import { FileAudio, FileText, Loader2, Search, X } from "@/components/icons";
import { api } from "@/lib/api";
import { apiUrl, authenticatedHeaders } from "@/lib/runtime";

type Result = { id: string; title: string; kind: string; to: string };
export function WorkspaceSearch() {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [rows, setRows] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const navigate = useNavigate();
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    if (!open || query.trim().length < 2) return;
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const headers = authenticatedHeaders();
        const [recordings, transcripts, documents] = await Promise.all([
          fetch(
            apiUrl(`/recordings?limit=20&search=${encodeURIComponent(query)}`),
            { headers, signal: abort.signal },
          ).then(async (r) => {
            if (!r.ok) throw new Error("Recording search unavailable.");
            return r.json();
          }),
          api.search(query, abort.signal),
          fetch(
            apiUrl(`/v1/documents?q=${encodeURIComponent(query)}&limit=20`),
            { headers, signal: abort.signal },
          ).then(async (r) => {
            if (!r.ok) throw new Error("Document search unavailable.");
            return r.json();
          }),
        ]);
        const results: Result[] = recordings.data.map(
          (r: { id: string; originalFilename: string }) => ({
            id: r.id,
            title: r.originalFilename,
            kind: "Recording",
            to: `/recording/${r.id}`,
          }),
        );
        for (const row of transcripts)
          if (!results.some((r) => r.id === row.recordingId))
            results.push({
              id: row.recordingId,
              title: row.recordingTitle,
              kind: "Transcript",
              to: `/recording/${row.recordingId}`,
            });
        for (const row of documents.data.documents)
          results.push({
            id: row.id,
            title: row.title,
            kind: "Document",
            to: `/notes?document=${row.id}`,
          });
        if (!abort.signal.aborted) setRows(results);
      } catch (e) {
        if (!abort.signal.aborted) setError((e as Error).message);
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    }, 180);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [query, open]);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        setLoading(false);
        setError("");
      }}
    >
      <Dialog.Trigger className="command-search">
        <Search />
        <span>Search recordings, transcripts, documents...</span>
        <kbd>⌘ K</kbd>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="command-overlay" />
        <Dialog.Content className="command-dialog" aria-describedby={undefined}>
          <Dialog.Title className="sr-only">Search workspace</Dialog.Title>
          <div className="command-input">
            <Search />
            <input
              autoFocus
              aria-label="Search workspace"
              placeholder="Search recordings, transcripts, documents..."
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setRows([]);
                setError("");
                setLoading(e.target.value.trim().length >= 2);
              }}
            />
            <Dialog.Close aria-label="Close search">
              <X />
            </Dialog.Close>
          </div>
          <div className="command-results">
            {loading && <Loader2 className="animate-spin" />}
            {error && <p role="alert">{error}</p>}
            {query.trim().length < 2 ? (
              <p>Search your workspace</p>
            ) : !loading && !rows.length && !error ? (
              <p>No results found.</p>
            ) : (
              rows.map((row) => (
                <button
                  key={`${row.kind}-${row.id}`}
                  onClick={() => {
                    setOpen(false);
                    navigate(row.to);
                  }}
                >
                  {row.kind === "Recording" ? <FileAudio /> : <FileText />}
                  <span>
                    {row.title}
                    <small>{row.kind}</small>
                  </span>
                </button>
              ))
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
