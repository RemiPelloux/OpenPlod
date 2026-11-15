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
  Share2,
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
import { exportOriginalAudio } from "@/lib/document-export";
import { formatDuration } from "@/lib/utils";
import { formatDate, t, tn } from "@/i18n";
import { BatchTranscribe } from '@/components/BatchTranscribe'
import { COLLECTIONS_EVENT, CollectionContextSubmenu, CollectionDropdownSubmenu, CollectionNameDialog } from '@/components/RecordingCollections'
import { knowledgeApi, type RecordingCollection } from '@/lib/knowledge'

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
  const collectionParam = params.get("collection");
  const collectionId = retention === "active" && collectionParam && /^[0-9a-f-]{36}$/i.test(collectionParam) ? collectionParam : null;
  const [collections, setCollections] = useState<RecordingCollection[]>([]);
  const [naming, setNaming] = useState<{ mode: "create"; recordingId?: string } | { mode: "rename"; collection: RecordingCollection } | null>(null);
  const activeCollection = collections.find((row) => row.id === collectionId) ?? null;
  const loadCollections = useCallback(async () => {
    try { setCollections(await knowledgeApi.collections()); } catch { /* The library still works without collections. */ }
  }, []);
  useEffect(() => {
    void loadCollections();
    window.addEventListener(COLLECTIONS_EVENT, loadCollections);
    return () => window.removeEventListener(COLLECTIONS_EVENT, loadCollections);
  }, [loadCollections]);
  const collectionsChanged = () => window.dispatchEvent(new Event(COLLECTIONS_EVENT));
  const revision = useRef(0);
  const [tagRecording, setTagRecording] = useState<Recording | null>(null);
  const [tagRefresh, setTagRefresh] = useState(0);
  const tagEditorOpen = useRef(false);
  const tagReturnFocus = useRef<HTMLElement | null>(null);
  const [exporting, setExporting] = useState(false);
  const exportAudio = async (row: Recording) => {
    if (exporting) return;
    setExporting(true);
    setError("");
    try {
      await exportOriginalAudio(row);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setExporting(false);
    }
  };
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
      const rows = await api.getRecordings({ retention, limit: "100", ...(collectionId ? { collection: collectionId } : {}) });
      if (ticket === revision.current) {
        setRecordings(rows);
        setMore(rows.length === 100);
      }
    } catch (e) {
      if (ticket === revision.current) setError((e as Error).message);
    } finally {
      if (ticket === revision.current) setLoading(false);
    }
  }, [retention, collectionId]);
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
  const activeRecording = filtered.find((row) => row.id === selected) ?? filtered[0];
  const activeId = activeRecording?.id;
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
        ...(collectionId ? { collection: collectionId } : {}),
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
        t("Permanently delete this recording and its audio? This cannot be undone."),
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
  /** Add to or remove from a collection; a stale revision reloads the collections and says so. */
  const toggleCollection = async (row: Recording, collection: RecordingCollection, member: boolean) => {
    setError("");
    try {
      if (member) await knowledgeApi.addToCollection(collection.id, [row.id], collection.revision);
      else await knowledgeApi.removeFromCollection(collection.id, [row.id], collection.revision);
      setRecordings((current) => current
        .map((item) => item.id === row.id ? { ...item, collectionIds: member ? [...new Set([...(item.collectionIds ?? []), collection.id])] : (item.collectionIds ?? []).filter((id) => id !== collection.id) } : item)
        .filter((item) => !(collectionId === collection.id && !member && item.id === row.id)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      collectionsChanged();
    }
  };
  const deleteCollection = async (collection: RecordingCollection) => {
    if (!window.confirm(t('Delete the collection "{name}"? Its recordings are kept.', { name: collection.name }))) return;
    try {
      await knowledgeApi.deleteCollection(collection.id, collection.revision);
      collectionsChanged();
      navigate("/recordings");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const collectionMenu = (row: Recording) => ({
    collections,
    memberOf: row.collectionIds ?? [],
    onToggle: (collection: RecordingCollection, member: boolean) => void toggleCollection(row, collection, member),
    onCreate: () => setNaming({ mode: "create", recordingId: row.id }),
  });
  const filters = [
    { id: "all", label: t("All"), icon: FileAudio },
    { id: "voice", label: t("Voice"), icon: Mic },
    { id: "plaud", label: "Plaud", icon: Bluetooth },
    { id: "starred", label: t("Starred"), icon: Star },
    { id: "imported", label: t("Imported"), icon: Upload },
  ];
  return (
    <div className="studio-page">
      {location.pathname === "/" && retention === "active" && !starred && (
        <WorkspaceTiles />
      )}
      <div
        className={`studio-columns ${retention === "trash" ? "trash-layout" : ""}`}
      >
        <section className="studio-library" aria-label={t("Recording library")}>
          <header className="studio-library-heading">
            <div>
              <h1>
                {retention === "trash"
                  ? t("Trash")
                  : starred
                    ? t("Starred")
                    : collectionId
                      ? activeCollection?.name ?? t("Collection")
                      : t("Recordings")}
              </h1>
              <p>
                {loading && !recordings.length
                  ? t("Loading recordings...")
                  : more
                    ? tn(filtered.length, "{count}+ recording", "{count}+ recordings")
                    : tn(filtered.length, "{count} recording", "{count} recordings")}
              </p>
            </div>
            {collectionId && activeCollection ? (
              <div className="studio-collection-tools">
                <Button variant="outline" size="sm" onClick={() => setNaming({ mode: "rename", collection: activeCollection })}><Pencil />{t("Rename")}</Button>
                <Button variant="ghost" size="sm" onClick={() => void deleteCollection(activeCollection)}><Trash2 />{t("Delete collection")}</Button>
              </div>
            ) : (
              <PlaudImportDialog />
            )}
          </header>
          {retention === "active" && (
            <BatchTranscribe recordings={recordings} onFinished={() => void load()} />
          )}
          <div className="studio-library-toolbar">
            <div className="studio-source-actions">
              <div
                className="studio-source-tabs"
                role="tablist"
                aria-label={t("Recording source")}
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
              {retention === "active" && (
                <button type="button" className="studio-export-action" disabled={!activeRecording || exporting}
                  title={activeRecording?.title}
                  onClick={() => { if (activeRecording) void exportAudio(activeRecording); }}>
                  <Share2 /><span>Export</span>
                </button>
              )}
            </div>
            <div className="studio-sort-tools">
              <button
                className="studio-control"
                onClick={() => setFiltersOpen(true)}
                title={t("Filter recordings")}
              >
                <SlidersHorizontal />
                <span>{t("Filters")}</span>
              </button>
              <select
                aria-label={t("Sort recordings")}
                value={sort}
                onChange={(e) => setSort(e.target.value)}
              >
                <option value="newest">{t("Newest first")}</option>
                <option value="oldest">{t("Oldest first")}</option>
                <option value="title">{t("Title A-Z")}</option>
              </select>
              <div className="studio-view-toggle">
                <button
                  aria-label={t("List view")}
                  aria-pressed={view === "list"}
                  onClick={() => setView("list")}
                >
                  <List />
                </button>
                <button
                  aria-label={t("Grid view")}
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
                {t("Retry")}
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
                  ? t("No matching recordings")
                  : retention === "trash"
                    ? t("Trash is empty")
                    : collectionId
                      ? t("No recordings in this collection")
                      : t("No recordings yet")}
              </h2>
              {retention === "trash" ? (
                <p>{t("Deleted recordings remain recoverable for 30 days.")}</p>
              ) : collectionId ? (
                <p>{t("Right-click a recording, or use its actions menu, and choose Add to collection.")}</p>
              ) : (
                <Button asChild variant="outline">
                  <Link to="/record">
                    <Mic />
                    {t("New recording")}
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
                    aria-label={t("Open {title}", { title: row.title })}
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
                            : row.recordingType === 'other' ? t('Imported') : row.recordingType,
                        ]
                    )
                      .slice(0, 2)
                      .map((tag) => (
                        <span key={tag}>{tag}</span>
                      ))}
                  </div>
                  <time dateTime={row.recordedAt}>
                    {formatDate(row.recordedAt, {
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
                          title={t("Restore recording")}
                          aria-label={t("Restore {title}", { title: row.title })}
                          onClick={() => void restore(row.id)}
                        >
                          <RotateCcw />
                        </button>
                        <button
                          title={t("Permanently delete")}
                          aria-label={t("Permanently delete {title}", { title: row.title })}
                          onClick={() => void purge(row.id)}
                        >
                          <Trash2 />
                        </button>
                      </>
                    ) : (
                      <DropdownMenu.Root>
                        <DropdownMenu.Trigger
                          aria-label={t("Actions for {title}", { title: row.title })}
                          title={t("Recording actions")}
                        >
                          <MoreHorizontal />
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content className="action-menu" align="end" sideOffset={6} onCloseAutoFocus={event => { if (tagEditorOpen.current) event.preventDefault(); }}>
                            <DropdownMenu.Item onSelect={() => choose(row.id)}>
                              <Play />{t("Open preview")}
                            </DropdownMenu.Item>
                            <DropdownMenu.Item disabled={exporting} onSelect={() => void exportAudio(row)}>
                              <Share2 />{t("Export audio")}
                            </DropdownMenu.Item>
                            <DropdownMenu.Item onSelect={() => editTags(row)}>
                              <Tags />{t("Edit tags")}
                            </DropdownMenu.Item>
                            <CollectionDropdownSubmenu {...collectionMenu(row)} />
                            <DropdownMenu.Item asChild>
                              <Link to={`/recording/${row.id}`}>
                                <Pencil />{t("Edit recording")}
                              </Link>
                            </DropdownMenu.Item>
                            <DropdownMenu.Item
                              onSelect={() =>
                                navigate(`/ai?recording=${row.id}`)
                              }
                            >
                              <MessageSquare />{t("Ask AI")}
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
                    <ContextMenu.Item onSelect={() => choose(row.id)}><Play />{t("Open preview")}</ContextMenu.Item>
                    {retention === "active" && (
                      <ContextMenu.Item disabled={exporting} onSelect={() => void exportAudio(row)}><Share2 />{t("Export audio")}</ContextMenu.Item>
                    )}
                    <ContextMenu.Item onSelect={() => editTags(row)}><Tags />{t("Edit tags")}</ContextMenu.Item>
                    <CollectionContextSubmenu {...collectionMenu(row)} />
                    <ContextMenu.Item onSelect={() => navigate(`/recording/${row.id}`)}><Pencil />{t("Edit recording")}</ContextMenu.Item>
                    <ContextMenu.Item onSelect={() => navigate(`/ai?recording=${row.id}`)}><MessageSquare />{t("Ask AI")}</ContextMenu.Item>
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
              <ChevronDown />{t("Load more recordings")}
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
                <p>{t("Select a recording")}</p>
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
      {naming && (
        <CollectionNameDialog
          title={naming.mode === "rename" ? t("Rename collection") : t("New collection")}
          initial={naming.mode === "rename" ? naming.collection.name : ""}
          onClose={() => setNaming(null)}
          onSubmit={async (name) => {
            if (naming.mode === "rename") {
              await knowledgeApi.updateCollection(naming.collection.id, { name, revision: naming.collection.revision });
            } else {
              const created = await knowledgeApi.createCollection(name);
              if (naming.recordingId) {
                const recordingId = naming.recordingId;
                await knowledgeApi.addToCollection(created.id, [recordingId], created.revision);
                setRecordings((current) => current.map((item) => item.id === recordingId ? { ...item, collectionIds: [...(item.collectionIds ?? []), created.id] } : item));
              }
            }
            collectionsChanged();
          }}
        />
      )}
      <Dialog.Root open={filtersOpen} onOpenChange={setFiltersOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="mobile-filter-overlay" />
          <Dialog.Content
            className="mobile-filter-sheet"
            aria-describedby={undefined}
          >
            <div className="flex items-center justify-between">
              <Dialog.Title>{t("Filter recordings")}</Dialog.Title>
              <Dialog.Close aria-label={t("Close filters")}>
                <X />
              </Dialog.Close>
            </div>
            <label className="studio-filter-label">
              {t("Title or tag")}
              <input
                aria-label={t("Filter by title or tag")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <label className="studio-filter-label">
              {t("Processing status")}
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                {([["all", t("All")], ["complete", t("Complete")], ["pending", t("Pending")], ["transcribing", t("Transcribing")], ["failed", t("Failed")]] as const).map(
                  ([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ),
                )}
              </select>
            </label>
            <Dialog.Close asChild>
              <Button><Check />{t("Show recordings")}</Button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
