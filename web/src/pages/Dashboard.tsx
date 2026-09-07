import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import {
  AlertCircle,
  Bluetooth,
  FileAudio,
  LayoutGrid,
  List,
  Loader2,
  Mic,
  MoreHorizontal,
  Play,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Star,
  Trash2,
  Upload,
  X,
  MessageSquare,
  Pencil,
  ChevronDown,
  Check,
  Tags,
} from "@/components/icons";
import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { PlaudImportDialog } from "@/components/PlaudImportDialog";
import { RecordingPreview } from "@/components/RecordingPreview";
import { WorkspaceTiles } from "@/components/WorkspaceTiles";
import { RecordingTagsDialog } from "@/components/RecordingTagsDialog";
import { Button } from "@/components/ui/button";
import { api, type Recording } from "@/lib/api";
import { formatDuration } from "@/lib/utils";

export function Dashboard() {
  const [recordings, setRecordings] = useState<Recording[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [view, setView] = useState<"grid" | "list">("list"),
    [sort, setSort] = useState("newest"),
    [status, setStatus] = useState("all");
  const [source, setSource] = useState("all"),
    [filtersOpen, setFiltersOpen] = useState(false),
    [query, setQuery] = useState(""),
    [more, setMore] = useState(false),
    [selected, setSelected] = useState("");
  const [params] = useSearchParams(),
    navigate = useNavigate(),
    location = useLocation();
  const retention = params.get("view") === "trash" ? "trash" : "active";
  const starred = params.get("view") === "starred";
  const revision = useRef(0);
  const [tagRecording, setTagRecording] = useState<Recording | null>(null);
  const [tagRefresh, setTagRefresh] = useState(0);
  const tagEditorOpen = useRef(false);
  const tagReturnFocus = useRef<HTMLElement | null>(null);
  const editTags = (row: Recording) => {
    tagReturnFocus.current = document.getElementById(`recording-open-${row.id}`);
    tagEditorOpen.current = true;
    setTagRecording(row);
  };
  const closeTags = () => {
    tagEditorOpen.current = false;
    setTagRecording(null);
    requestAnimationFrame(() => tagReturnFocus.current?.focus());
  };
  const [wide, setWide] = useState(
    () => window.matchMedia("(min-width: 1101px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1101px)");
    const update = () => setWide(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const invalidate = useCallback(() => {
    revision.current++;
  }, []);
  const load = useCallback(async () => {
    const ticket = ++revision.current;
    setLoading(true);
    setError("");
    try {
      const rows = await api.getRecordings({ retention, limit: "100" });
      if (ticket === revision.current) {
        setRecordings(rows);
        setMore(rows.length === 100);
      }
    } catch (e) {
      if (ticket === revision.current) setError((e as Error).message);
    } finally {
      if (ticket === revision.current) setLoading(false);
    }
  }, [retention]);
  useEffect(() => {
    void load();
    window.addEventListener("plaud:sync-complete", load);
    return () => {
      invalidate();
      window.removeEventListener("plaud:sync-complete", load);
    };
  }, [load, invalidate]);
  const search = useDeferredValue(query.toLocaleLowerCase());
  const filtered = useMemo(
    () =>
      recordings
        .filter((row) => {
          if (
            (starred || source === "starred") &&
            !row.tags.includes("Starred")
          )
            return false;
          if (source === "plaud" && row.sourceProvider !== "plaud")
            return false;
          if (
            source === "voice" &&
            !["opennotes", "mobile", "microphone"].includes(
              row.sourceProvider || "",
            )
          )
            return false;
          if (
            source === "imported" &&
            ["plaud", "opennotes", "mobile", "microphone"].includes(
              row.sourceProvider || "",
            )
          )
            return false;
          return (
            (status === "all" || row.status === status) &&
            (!search ||
              `${row.title} ${row.tags.join(" ")}`
                .toLocaleLowerCase()
                .includes(search))
          );
        })
        .sort((a, b) =>
          sort === "title"
            ? a.title.localeCompare(b.title)
            : (sort === "oldest" ? 1 : -1) *
              (Date.parse(a.recordedAt) - Date.parse(b.recordedAt)),
        ),
    [recordings, source, starred, status, search, sort],
  );
  const activeId =
    filtered.find((row) => row.id === selected)?.id || filtered[0]?.id;
  const choose = (id: string) => {
    setSelected(id);
    if (window.matchMedia("(max-width: 1100px)").matches)
      navigate(`/recording/${id}`);
  };
  const moreRows = async () => {
    const ticket = revision.current;
    setLoading(true);
    try {
      const rows = await api.getRecordings({
        retention,
        limit: "100",
        offset: String(recordings.length),
      });
      if (ticket === revision.current) {
        setRecordings((current) => [...current, ...rows]);
        setMore(rows.length === 100);
      }
    } catch (e) {
      if (ticket === revision.current) setError((e as Error).message);
    } finally {
      if (ticket === revision.current) setLoading(false);
    }
  };
  const restore = async (id: string) => {
    try {
      await api.restoreRecording(id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const purge = async (id: string) => {
    if (
      !window.confirm(
        "Permanently delete this recording and its audio? This cannot be undone.",
      )
    )
      return;
    try {
      await api.purgeRecording(id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const filters = [
    { id: "all", label: "All", icon: FileAudio },
    { id: "voice", label: "Voice", icon: Mic },
    { id: "plaud", label: "Plaud", icon: Bluetooth },
    { id: "imported", label: "Imported", icon: Upload },
    { id: "starred", label: "Starred", icon: Star },
  ];
  return (
    <div className="studio-page">
      {location.pathname === "/" && retention === "active" && !starred && (
        <WorkspaceTiles />
      )}
      <div
        className={`studio-columns ${retention === "trash" ? "trash-layout" : ""}`}
      >
        <section className="studio-library" aria-label="Recording library">
          <header className="studio-library-heading">
            <div>
              <h1>
                {retention === "trash"
                  ? "Trash"
                  : starred
                    ? "Starred"
                    : "Recordings"}
              </h1>
              <p>
                {loading && !recordings.length
                  ? "Loading recordings..."
                  : `${filtered.length}${more ? "+" : ""} recording${filtered.length === 1 ? "" : "s"}`}
              </p>
            </div>
            <PlaudImportDialog />
          </header>
          <div className="studio-library-toolbar">
            <div
              className="studio-source-tabs"
              role="tablist"
              aria-label="Recording source"
            >
              {filters.map(({ id, label, icon: Icon }, index) => (
                <button
                  key={id}
                  id={`source-tab-${id}`}
                  role="tab"
                  aria-label={label}
                  title={label}
                  aria-selected={source === id}
                  tabIndex={source === id ? 0 : -1}
                  onClick={() => setSource(id)}
                  onKeyDown={event => {
                    const next = event.key === 'ArrowRight' ? (index + 1) % filters.length : event.key === 'ArrowLeft' ? (index + filters.length - 1) % filters.length : event.key === 'Home' ? 0 : event.key === 'End' ? filters.length - 1 : null
                    if (next === null) return
                    event.preventDefault(); setSource(filters[next].id); document.getElementById(`source-tab-${filters[next].id}`)?.focus()
                  }}
                >
                  <Icon />
                  <span>{label}</span>
                </button>
              ))}
            </div>
            <div className="studio-sort-tools">
              <button
                className="studio-control"
                onClick={() => setFiltersOpen(true)}
                aria-label="Filter recordings"
              >
                <SlidersHorizontal />
                <span>Filters</span>
              </button>
              <select
                aria-label="Sort recordings"
                value={sort}
                onChange={(e) => setSort(e.target.value)}
              >
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
                <option value="title">Title A-Z</option>
              </select>
              <div className="studio-view-toggle">
                <button
                  aria-label="List view"
                  aria-pressed={view === "list"}
                  onClick={() => setView("list")}
                >
                  <List />
                </button>
                <button
                  aria-label="Grid view"
                  aria-pressed={view === "grid"}
                  onClick={() => setView("grid")}
                >
                  <LayoutGrid />
                </button>
              </div>
            </div>
          </div>
          {error && (
            <div className="studio-error" role="alert">
              <AlertCircle />
              <p>{error}</p>
              <Button variant="ghost" onClick={() => void load()}>
                <RefreshCw />
                Retry
              </Button>
            </div>
          )}
          {loading && !recordings.length ? (
            <div className="preview-empty">
              <Loader2 className="animate-spin" />
            </div>
          ) : !filtered.length && !error ? (
            <div className="studio-empty">
              <FileAudio />
              <h2>
                {search || source !== "all" || status !== "all"
                  ? "No matching recordings"
                  : retention === "trash"
                    ? "Trash is empty"
                    : "No recordings yet"}
              </h2>
              {retention === "trash" ? (
                <p>Deleted recordings remain recoverable for 30 days.</p>
              ) : (
                <Button asChild variant="outline">
                  <Link to="/record">
                    <Mic />
                    New recording
                  </Link>
                </Button>
              )}
            </div>
          ) : (
            <div
              className={`studio-recordings ${view === "grid" ? "studio-grid" : ""}`}
            >
              {filtered.map((row) => (
                <ContextMenu.Root key={row.id}>
                <ContextMenu.Trigger asChild disabled={retention === "trash"}>
                <article
                  data-recording-id={row.id}
                  className={`studio-recording ${activeId === row.id && retention === "active" ? "selected" : ""}`}
                >
                  <button
                    id={`recording-open-${row.id}`}
                    className="studio-row-main"
                    onClick={() => choose(row.id)}
                    aria-label={`Open ${row.title}`}
                    aria-pressed={activeId === row.id}
                  >
                    <span className="studio-source-icon">
                      {row.sourceProvider === "plaud" ? (
                        <FileAudio />
                      ) : ["opennotes", "mobile", "microphone"].includes(
                          row.sourceProvider || "",
                        ) ? (
                        <Mic />
                      ) : (
                        <Play />
                      )}
                    </span>
                    <strong>{row.title}</strong>
                  </button>
                  <div className="studio-row-tags">
                    {(row.tags.filter((tag) => tag !== "Starred").length
                      ? row.tags.filter((tag) => tag !== "Starred")
                      : [
                          row.sourceProvider === "plaud"
                            ? "Plaud"
                            : row.recordingType === 'other' ? 'Imported' : row.recordingType,
                        ]
                    )
                      .slice(0, 2)
                      .map((tag) => (
                        <span key={tag}>{tag}</span>
                      ))}
                  </div>
                  <time dateTime={row.recordedAt}>
                    {new Date(row.recordedAt).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                  <span className="studio-row-duration">
                    {formatDuration(row.duration)}
                  </span>
                  <div className="studio-row-actions">
                    {retention === "trash" ? (
                      <>
                        <button
                          title="Restore recording"
                          aria-label={`Restore ${row.title}`}
                          onClick={() => void restore(row.id)}
                        >
                          <RotateCcw />
                        </button>
                        <button
                          title="Permanently delete"
                          aria-label={`Permanently delete ${row.title}`}
                          onClick={() => void purge(row.id)}
                        >
                          <Trash2 />
                        </button>
                      </>
                    ) : (
                      <DropdownMenu.Root>
                        <DropdownMenu.Trigger
                          aria-label={`Actions for ${row.title}`}
                          title="Recording actions"
                        >
                          <MoreHorizontal />
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content className="action-menu" align="end" sideOffset={6} onCloseAutoFocus={event => { if (tagEditorOpen.current) event.preventDefault(); }}>
                            <DropdownMenu.Item onSelect={() => choose(row.id)}>
                              <Play />Open preview
                            </DropdownMenu.Item>
                            <DropdownMenu.Item onSelect={() => editTags(row)}>
                              <Tags />Edit tags
                            </DropdownMenu.Item>
                            <DropdownMenu.Item asChild>
                              <Link to={`/recording/${row.id}`}>
                                <Pencil />Edit recording
                              </Link>
                            </DropdownMenu.Item>
                            <DropdownMenu.Item
                              onSelect={() =>
                                navigate(`/ai?recording=${row.id}`)
                              }
                            >
                              <MessageSquare />Ask AI
                            </DropdownMenu.Item>
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu.Root>
                    )}
                  </div>
                </article>
                </ContextMenu.Trigger>
                <ContextMenu.Portal>
                  <ContextMenu.Content className="action-menu" onCloseAutoFocus={event => { if (tagEditorOpen.current) event.preventDefault(); }}>
                    <ContextMenu.Item onSelect={() => choose(row.id)}><Play />Open preview</ContextMenu.Item>
                    <ContextMenu.Item onSelect={() => editTags(row)}><Tags />Edit tags</ContextMenu.Item>
                    <ContextMenu.Item onSelect={() => navigate(`/recording/${row.id}`)}><Pencil />Edit recording</ContextMenu.Item>
                    <ContextMenu.Item onSelect={() => navigate(`/ai?recording=${row.id}`)}><MessageSquare />Ask AI</ContextMenu.Item>
                  </ContextMenu.Content>
                </ContextMenu.Portal>
                </ContextMenu.Root>
              ))}
            </div>
          )}
          {more && (
            <Button
              className="studio-load-more"
              variant="ghost"
              disabled={loading}
              onClick={() => void moreRows()}
            >
              <ChevronDown />Load more recordings
            </Button>
          )}
        </section>
        {wide &&
          (activeId && retention === "active" ? (
            <RecordingPreview
              key={activeId}
              id={activeId}
              metadataRefresh={tagRefresh}
              onUpdated={() => void load()}
            />
          ) : (
            retention === "active" && (
              <div className="studio-preview-empty">
                <FileAudio />
                <p>Select a recording</p>
              </div>
            )
          ))}
      </div>
      {tagRecording && <RecordingTagsDialog recording={tagRecording} onClose={closeTags} onSaved={updated => {
        invalidate();
        setRecordings(current => current.map(row => row.id === updated.id ? { ...row, ...updated } : row));
        setLoading(false);
        setTagRefresh(value => value + 1);
      }} />}
      <Dialog.Root open={filtersOpen} onOpenChange={setFiltersOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="mobile-filter-overlay" />
          <Dialog.Content
            className="mobile-filter-sheet"
            aria-describedby={undefined}
          >
            <div className="flex items-center justify-between">
              <Dialog.Title>Filter recordings</Dialog.Title>
              <Dialog.Close aria-label="Close filters">
                <X />
              </Dialog.Close>
            </div>
            <label className="studio-filter-label">
              Title or tag
              <input
                aria-label="Filter by title or tag"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <label className="studio-filter-label">
              Processing status
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                {["all", "complete", "pending", "transcribing", "failed"].map(
                  (value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ),
                )}
              </select>
            </label>
            <Dialog.Close asChild>
              <Button><Check />Show recordings</Button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
