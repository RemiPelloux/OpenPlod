export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand" aria-label="OpenPlod">
      <img src="/openplod-mark.svg" className="brand-mark" width="30" height="30" alt="" aria-hidden="true" />
      {!compact && (
        <span className="brand-wordmark">
          Open<span>Plod</span>
        </span>
      )}
    </div>
  )
}
