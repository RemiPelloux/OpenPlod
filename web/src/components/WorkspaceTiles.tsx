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
import { plaudModelImage, plaudModelName, usePlaudModel } from "@/lib/plaud-model";
import { t } from "@/i18n";

export function WorkspaceTiles() {
  const [engine, setEngine] = useState<Settings['transcriptionEngine'] | null>(null);
  useEffect(() => {
    let disposed = false;
    api.getSettings().then(settings => { if (!disposed) setEngine(settings.transcriptionEngine); }).catch(() => {});
    return () => { disposed = true; };
  }, []);
  const [plaud, setPlaud] = useState<PlaudStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const model = usePlaudModel(plaud?.deviceModel);
  const device = plaudModelName(model) ?? t("Plaud recorder");
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
    <section className="workspace-tiles" aria-label={t("Workspace connections")}>
      <Link className="workspace-tile plaud-tile" to="/devices">
        <img src={plaudModelImage(model)} alt={device} />
        <div>
          <strong className={plaud?.deviceDetected ? "device-present" : ""}>
            {plaud?.deviceDetected
              ? t("Plaud nearby")
              : unavailable
                ? t("Plaud unavailable")
                : plaud
                  ? device
                  : t("Checking Plaud...")}
          </strong>
          <p>{device}</p>
        </div>
        <ChevronRight className="tile-arrow" />
      </Link>
      <Link className="workspace-tile" to="/transcripts">
        <span className="tile-illustration tile-ai">
          <AudioLines />
        </span>
        <div>
          <strong>{t("Transcripts")}</strong>
          <p>{engine === 'whisper' ? t('Powered by local Whisper') : engine ? t('Powered by {engine}', { engine: { mistral: 'Mistral', deepgram: 'Deepgram', openai: 'OpenAI', assemblyai: 'AssemblyAI' }[engine] }) : t('Transcription settings')}</p>
        </div>
        <ChevronRight className="tile-arrow" />
      </Link>
      <Link className="workspace-tile" to="/notes">
        <span className="tile-illustration">
          <FileText />
        </span>
        <div>
          <strong>{t("Documents")}</strong>
          <p>{t("Markdown library")}</p>
        </div>
      </Link>
      <Link className="workspace-tile" to="/android">
        <span className="tile-illustration">
          <Smartphone />
        </span>
        <div>
          <strong>Android</strong>
          <p>{t("Pair your phone")}</p>
        </div>
        <ChevronRight className="tile-arrow" />
      </Link>
    </section>
  );
}
