export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand" aria-label="OpenPlod">
      <span className="brand-wave" aria-hidden="true">
        {[5, 11, 17, 9, 20, 13, 7].map((height, index) => (
          <span key={`${height}-${index}`} style={{ height }} />
        ))}
      </span>
      {!compact && (
        <span className="brand-wordmark">
          Open<span>Plod</span>
        </span>
      )}
    </div>
  )
}
