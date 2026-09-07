import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  AudioLines,
  ChevronRight,
  FileText,
  Smartphone,
} from "@/components/icons";
import { api, type PlaudStatus, type Settings } from "@/lib/api";
import { getRuntime } from "@/lib/runtime";

export function WorkspaceTiles() {
  const [engine, setEngine] = useState<Settings['transcriptionEngine'] | null>(null);
  useEffect(() => {
    let disposed = false;
    api.getSettings().then(settings => { if (!disposed) setEngine(settings.transcriptionEngine); }).catch(() => {});
    return () => { disposed = true; };
  }, []);
  const [plaud, setPlaud] = useState<PlaudStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let stopped = false;
    if (getRuntime().mode === "mobile") return;
    api
      .getPlaudStatus()
      .then((value) => {
        if (!stopped) setPlaud(value);
      })
      .catch(() => {
        if (!stopped) setUnavailable(true);
      });
    return () => {
      stopped = true;
    };
  }, []);
  return (
    <section className="workspace-tiles" aria-label="Workspace connections">
      <Link className="workspace-tile plaud-tile" to="/devices">
        <img src="/plaud-note-pro.png" alt="Plaud Note Pro" />
        <div>
          <strong className={plaud?.deviceDetected ? "device-present" : ""}>
            {plaud?.deviceDetected
              ? "Plaud nearby"
              : unavailable
                ? "Plaud unavailable"
                : plaud
                  ? "Plaud Note Pro"
                  : "Checking Plaud..."}
          </strong>
          <p>Plaud Note Pro</p>
        </div>
        <ChevronRight className="tile-arrow" />
      </Link>
      <Link className="workspace-tile" to="/transcripts">
        <span className="tile-illustration tile-ai">
          <AudioLines />
        </span>
        <div>
          <strong>Transcripts</strong>
          <p>{engine ? `Powered by ${{ mistral: 'Mistral', whisper: 'local Whisper', deepgram: 'Deepgram' }[engine]}` : 'Transcription settings'}</p>
        </div>
        <ChevronRight className="tile-arrow" />
      </Link>
      <Link className="workspace-tile" to="/notes">
        <span className="tile-illustration">
          <FileText />
        </span>
        <div>
          <strong>Documents</strong>
          <p>Markdown library</p>
        </div>
      </Link>
      <Link className="workspace-tile" to="/settings#pairing">
        <span className="tile-illustration">
          <Smartphone />
        </span>
        <div>
          <strong>Android</strong>
          <p>Pair your phone</p>
        </div>
        <ChevronRight className="tile-arrow" />
      </Link>
    </section>
  );
}
