import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type WaveSurfer from "wavesurfer.js";
import {
  ArrowUp,
  ArrowUpRight,
  BookmarkPlus,
  Clock3,
  Copy,
  Download,
  FileAudio,
  Loader2,
  MoreHorizontal,
  Pause,
  Play,
  Undo2,
  Redo2,
  Save,
  Share2,
  Star,
  AlertCircle,
  RefreshCw,
  FileText,
  NotebookPen,
  ListChecks,
  AlignLeft,
  ListTree,
  MessageSquare,
  Code,
} from "@/components/icons";
import { loadWaveform } from '@/lib/audio-loader';
import { IconButton } from './ui/icon-button';
import { PlaybackSpeedMenu } from './PlaybackSpeedMenu';
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Button } from "./ui/button";
import { RecordingBookmarks } from "./RecordingBookmarks";
import { SaveTranscriptDialog } from "./NoteDialogs";
import { api, type Recording } from "@/lib/api";
import { apiUrl, authenticatedHeaders, getRuntime } from "@/lib/runtime";
import {
  exportDocument,
  exportOriginalAudio,
  recordingMarkdown,
  safeDocumentName,
} from "@/lib/document-export";
import { formatDuration } from "@/lib/utils";

const contentTabs = ["Transcript", "AI Summary", "Notes", "Chapters", "Export"];
const tabIcons = [FileText, AlignLeft, NotebookPen, ListTree, Download];

export function RecordingPreview({
  id,
  metadataRefresh = 0,
  onUpdated,
}: {
  id: string;
  metadataRefresh?: number;
  onUpdated: () => void;
}) {
  const [recording, setRecording] = useState<Recording | null>(null),
    [error, setError] = useState("");
  const [tab, setTab] = useState("Transcript"),
    [playing, setPlaying] = useState(false),
    [time, setTime] = useState(0),
    [duration, setDuration] = useState(0),
    [speed, setSpeed] = useState(1);
  const [ready, setReady] = useState(false),
    [notes, setNotes] = useState(""),
    [busy, setBusy] = useState(false),
    [question, setQuestion] = useState(""),
    [notice, setNotice] = useState("");
  const [audioError, setAudioError] = useState('');
  const [audioAttempt, setAudioAttempt] = useState(0);
  const notesRevision = useRef<number | null>(null);
  const notesBase = useRef("");
  const container = useRef<HTMLDivElement>(null),
    wave = useRef<WaveSurfer | null>(null),
    audioUrl = useRef("");
  const navigate = useNavigate();
  useEffect(() => {
    let disposed = false;
    api
      .getRecording(id)
      .then((row) => {
        if (!disposed) {
          setRecording(row);
          if (notesRevision.current === null) setNotes(row.notes || "");
          else if ((row.notes || "") === notesBase.current) notesRevision.current = row.revision;
        }
      })
      .catch((e) => {
        if (!disposed) setError(e.message);
      });
    return () => {
      disposed = true;
    };
  }, [id, metadataRefresh]);
  useEffect(() => {
    if (!container.current) return;
    let disposed = false,
      objectUrl = "";
    const abort = new AbortController();
    let player: WaveSurfer | undefined;
    const host = container.current;
    void Promise.all([import("wavesurfer.js"), api.getAudioBlob(id, abort.signal)])
      .then(async ([{ default: Wave }, blob]) => {
        if (disposed) return;
        objectUrl = URL.createObjectURL(blob);
        audioUrl.current = objectUrl;
        player = Wave.create({
          container: host,
          height: 64,
          waveColor: "#69717f",
          progressColor: "#4b8bff",
          cursorColor: "#8ab5ff",
          cursorWidth: 1,
          barWidth: 1,
          barGap: 2,
          barRadius: 1,
          normalize: true,
          interact: true,
          dragToSeek: true,
        });
        wave.current = player;
        player.on("timeupdate", (value) => {
          if (!disposed) setTime(value);
        });
        player.on("play", () => {
          if (!disposed) setPlaying(true);
        });
        player.on("pause", () => {
          if (!disposed) setPlaying(false);
        });
        player.on("finish", () => {
          if (!disposed) setPlaying(false);
        });
        await loadWaveform(player, blob, abort.signal);
        if (!disposed) {
          setDuration(player.getDuration());
          setReady(true);
        }
      })
      .catch((e) => {
        if (!disposed) {
          setReady(false);
          setPlaying(false);
          setAudioError(e.name === 'TimeoutError' ? 'Audio download timed out. Retry playback.' : e instanceof TypeError ? 'Audio could not be downloaded. Check your vault connection and retry.' : e.message);
          player?.destroy();
          player = undefined;
          wave.current = null;
        }
      });
    return () => {
      disposed = true;
      abort.abort();
      player?.destroy();
      wave.current = null;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      audioUrl.current = "";
    };
  }, [id, audioAttempt]);
  useEffect(() => {
    if (ready) wave.current?.setPlaybackRate(speed);
  }, [ready, speed]);
  const retryAudio = () => { setAudioError(''); setReady(false); setPlaying(false); setTime(0); setAudioAttempt(value => value + 1); };
  const canDownloadAudio = !!recording && (!!audioUrl.current || getRuntime().mode !== 'browser');
  const seek = (seconds: number) =>
    wave.current?.setTime(Math.max(0, Math.min(duration, seconds)));
  const ask = (prompt: string) =>
    navigate(`/ai?${new URLSearchParams({ recording: id, question: prompt })}`);
  const saveNotes = async () => {
    if (!recording) return;
    setBusy(true);
    setError("");
    try {
      const next = await api.updateRecording(id, {
        notes,
        revision: notesRevision.current ?? recording.revision,
      });
      notesRevision.current = null;
      setRecording((row) =>
        row ? { ...row, notes, revision: next.revision } : row,
      );
      setNotice("Notes saved");
      onUpdated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const star = async () => {
    if (!recording) return;
    setBusy(true);
    try {
      const tags = recording.tags.includes("Starred")
        ? recording.tags.filter((tag) => tag !== "Starred")
        : [...recording.tags, "Starred"];
      const next = await api.updateRecording(id, {
        tags,
        revision: recording.revision,
      });
      if (notesRevision.current === recording.revision) notesRevision.current = next.revision;
      setRecording((row) =>
        row ? { ...row, tags, revision: next.revision } : row,
      );
      onUpdated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const download = async (format: "md" | "txt" | "json" | "audio") => {
    if (!recording) return;
    try {
      if (format === "audio") {
        if (getRuntime().mode === "mobile") {
          const { deviceCommand, vaultArguments } =
            await import("@/lib/plaud-device");
          await deviceCommand("exportVaultRecording", {
            ...vaultArguments(),
            recordingId: id,
            filename: recording.filename,
          });
        } else await exportOriginalAudio(recording, audioUrl.current);
      } else
        await exportDocument({
          filename: `${safeDocumentName(recording.title)}.${format}`,
          mime:
            format === "json"
              ? "application/json"
              : format === "md"
                ? "text/markdown"
                : "text/plain",
          content:
            format === "md"
              ? recordingMarkdown(recording, recording.transcriptText || "")
              : format === "json"
                ? JSON.stringify({ ...recording, filePath: undefined }, null, 2)
                : recording.transcriptText || "",
        });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const highlight = async (seconds: number, text: string) => {
    try {
      const response = await fetch(apiUrl(`/recordings/${id}/bookmarks`), {
        method: "POST",
        headers: authenticatedHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          id: crypto.randomUUID(),
          seconds,
          label: text.slice(0, 160),
        }),
      });
      if (!response.ok) throw new Error("Could not save highlight.");
      setNotice("Highlight saved");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section className="recording-preview" aria-label="Selected recording">
      <div className="preview-heading">
        <div>
          <h2>{recording?.title || "Loading recording..."}</h2>
          <p>
            <Clock3 />
            {recording
              ? new Date(recording.recordedAt).toLocaleString(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })
              : ""}
            <span>·</span>
            {formatDuration(duration || recording?.duration || 0)}
          </p>
        </div>
        <Button
          size="icon"
          variant="ghost"
          className={recording?.tags.includes("Starred") ? "is-starred" : ""}
          title="Star recording"
          aria-label="Star recording"
          aria-pressed={!!recording?.tags.includes("Starred")}
          disabled={!recording || busy}
          onClick={() => void star()}
        >
          <Star />
        </Button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <Button
              size="icon"
              variant="ghost"
              title="Recording actions"
              aria-label="Recording actions"
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="action-menu" align="end" sideOffset={6}>
              <DropdownMenu.Item asChild>
                <Link to={`/recording/${id}`}>
                  <ArrowUpRight />
                  Open full recording
                </Link>
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onSelect={() => {
                  setTab("Notes");
                }}
              >
                <NotebookPen />Edit notes
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => void download("md")}>
                <Download />Export Markdown
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      <div className="preview-player">
        <Button
          className="preview-play"
          size="icon"
          disabled={!ready && !audioError}
          onClick={() => {
            if (audioError) { retryAudio(); return; }
            void wave.current
              ?.playPause()
              .catch(() => setError("Playback could not start."));
          }}
          aria-label={audioError ? 'Retry playback' : playing ? "Pause recording" : "Play recording"}
        >
          {audioError ? <RefreshCw /> : !ready ? (
            <Loader2 className="animate-spin" />
          ) : playing ? (
            <Pause />
          ) : (
            <Play />
          )}
        </Button>
        <div className="preview-wave">
          <div ref={container} />
          <div className="preview-times">
            <span>{formatDuration(time)}</span>
            <span>{formatDuration(duration || recording?.duration || 0)}</span>
          </div>
          <input
            className="sr-only"
            type="range"
            aria-label="Seek recording"
            min={0}
            max={duration || 1}
            step={0.1}
            value={time}
            onChange={(e) => seek(Number(e.target.value))}
          />
        </div>
      </div>
      {audioError && <div className="preview-audio-error" role="alert"><AlertCircle /><span>{audioError}</span><Button size="sm" variant="ghost" onClick={retryAudio}><RefreshCw />Retry</Button></div>}
      <div className="preview-playback-tools">
        <PlaybackSpeedMenu value={speed} onChange={setSpeed} />
        <IconButton
          label="Back 15 seconds"
          disabled={!ready}
          onClick={() => seek(time - 15)}
        >
          <Undo2 />
        </IconButton>
        <IconButton
          label="Forward 15 seconds"
          disabled={!ready}
          onClick={() => seek(time + 15)}
        >
          <Redo2 />
        </IconButton>
        <span />
        <IconButton
          label="Download original audio"
          disabled={!canDownloadAudio}
          onClick={() => void download("audio")}
        >
          <Download />
        </IconButton>
        <IconButton
          label="Export recording"
          onClick={() => setTab("Export")}
        >
          <Share2 />
        </IconButton>
      </div>
      <div
        className="preview-tabs"
        role="tablist"
        aria-label="Recording content"
      >
        {contentTabs.map((value, index) => {
          const Icon = tabIcons[index];
          return (
          <button
            key={value}
            id={`preview-tab-${index}`}
            role="tab"
            aria-label={value}
            title={value}
            aria-selected={value === tab}
            aria-controls="preview-content"
            tabIndex={value === tab ? 0 : -1}
            onClick={() => setTab(value)}
            onKeyDown={(event) => {
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % contentTabs.length
                  : event.key === "ArrowLeft"
                    ? (index + contentTabs.length - 1) % contentTabs.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? contentTabs.length - 1
                        : null;
              if (next === null) return;
              event.preventDefault();
              setTab(contentTabs[next]);
              document.getElementById(`preview-tab-${next}`)?.focus();
            }}
          >
            <Icon aria-hidden="true" /><span>{value}</span>
          </button>
        )})}
      </div>
      <div
        className="preview-body"
        id="preview-content"
        role="tabpanel"
        aria-labelledby={`preview-tab-${contentTabs.indexOf(tab)}`}
        tabIndex={0}
      >
        {error && (
          <p className="device-error" role="alert">
            {error}
          </p>
        )}
        {tab === "Transcript" &&
          (recording?.segments?.length ? (
            <div className="preview-segments">
              {recording.segments.map((segment, index) => (
                <div
                  className={`preview-segment ${time >= segment.startTime && time < segment.endTime ? "current" : ""}`}
                  key={segment.id}
                >
                  <button
                    className="preview-timestamp"
                    onClick={() => seek(segment.startTime)}
                  >
                    {formatDuration(segment.startTime)}
                  </button>
                  <div>
                    <strong>
                      <i
                        style={{
                          background: ["#4d89ff", "#a378ed", "#5bc8c8"][
                            Math.max(
                              0,
                              recording.segments!.findIndex(
                                (row) => row.speaker === segment.speaker,
                              ),
                            ) % 3
                          ],
                        }}
                      />
                      {segment.speaker}
                    </strong>
                    <p>{segment.text}</p>
                    <div className="segment-quick-actions">
                      <button
                        aria-label={`Copy segment ${index + 1}`}
                        title="Copy segment"
                        onClick={() => {
                          void navigator.clipboard
                            .writeText(segment.text)
                            .then(() => setNotice("Copied"))
                            .catch(() => setError("Clipboard unavailable."));
                        }}
                      >
                        <Copy />
                      </button>
                      <button
                        aria-label={`Ask AI about segment ${index + 1}`}
                        title="Ask AI"
                        onClick={() =>
                          ask(
                            `Explain this passage using the recording as context: ${segment.text}`,
                          )
                        }
                      >
                        <MessageSquare />
                      </button>
                      <button
                        aria-label={`Highlight segment ${index + 1}`}
                        title="Highlight"
                        onClick={() =>
                          void highlight(segment.startTime, segment.text)
                        }
                      >
                        <BookmarkPlus />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : recording?.transcriptText ? (
            <div className="markdown-document">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {recording.transcriptText}
              </ReactMarkdown>
            </div>
          ) : (
            <div className="preview-empty">
              <FileAudio />
              <p>No transcript yet.</p>
              <Button onClick={() => navigate(`/recording/${id}`)}>
                <FileText />Open transcription
              </Button>
            </div>
          ))}
        {tab === "AI Summary" && (
          <div className="markdown-document">
            {recording?.summary ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {recording.summary}
              </ReactMarkdown>
            ) : (
              <div className="preview-empty">
                <AlignLeft />
                <p>No saved summary yet.</p>
                <Button
                  disabled={!recording?.transcriptText}
                  onClick={() =>
                    ask("Summarize this recording with source citations.")
                  }
                >
                  <AlignLeft />Summarize recording
                </Button>
              </div>
            )}
          </div>
        )}
        {tab === "Notes" && (
          <div className="preview-notes">
            <label htmlFor="preview-notes">Recording notes</label>
            <textarea
              id="preview-notes"
              value={notes}
              onChange={(e) => {
                if (notesRevision.current === null) {
                  notesRevision.current = recording?.revision ?? null;
                  notesBase.current = recording?.notes || "";
                }
                if (e.target.value === (recording?.notes || "")) notesRevision.current = null;
                setNotes(e.target.value);
              }}
              rows={12}
            />
            <Button
              size="sm"
              disabled={busy || !recording || notes === (recording.notes || "")}
              onClick={() => void saveNotes()}
            >
              <Save />
              Save notes
            </Button>
          </div>
        )}
        {tab === "Chapters" && (
          <RecordingBookmarks recordingId={id} currentTime={time} seek={seek} />
        )}
        {tab === "Export" && (
          <div className="preview-exports">
            {(["md", "txt", "json", "audio"] as const).map((format) => (
              <Button
                key={format}
                variant="outline"
                disabled={
                  !recording ||
                  (format === "audio" ? !canDownloadAudio : !recording.transcriptText)
                }
                onClick={() => void download(format)}
              >
                {format === 'md' ? <FileText /> : format === 'txt' ? <AlignLeft /> : format === 'json' ? <Code /> : <FileAudio />}
                {
                  {
                    md: "Markdown",
                    txt: "Plain text",
                    json: "JSON",
                    audio: "Audio file",
                  }[format]
                }
              </Button>
            ))}
            <Link to={`/recording/${id}`}>
              Transcript versions and recording details
              <ArrowUpRight />
            </Link>
          </div>
        )}
      </div>
      <div className="preview-ai">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (question.trim()) ask(question);
          }}
        >
          <input
            aria-label="Ask AI about this recording"
            placeholder="Ask AI about this recording..."
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            maxLength={4000}
          />
          <button
            type="submit"
            title="Ask AI"
            aria-label="Ask AI"
            disabled={!question.trim() || !recording?.transcriptText}
          >
            <ArrowUp />
          </button>
        </form>
        <div className="preview-ai-actions">
          <button
            disabled={!recording?.transcriptText}
            onClick={() => ask("Summarize this meeting with source citations.")}
          >
            <AlignLeft />Summary
          </button>
          <button
            disabled={!recording?.transcriptText}
            onClick={() =>
              ask(
                "Extract explicitly mentioned action items with source citations.",
              )
            }
          >
            <ListChecks />Action items
          </button>
          {recording && (
            <SaveTranscriptDialog
              recordingId={id}
              versionId={recording.transcriptVersionId ?? null}
              title={recording.title}
              disabled={!recording.transcriptText}
            />
          )}
        </div>
        {notice && (
          <p className="preview-notice" role="status">
            {notice}
          </p>
        )}
      </div>
    </section>
  );
}
