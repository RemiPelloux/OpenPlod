declare const __OPENPLOD_BUILD__: { version: string; builtAt: string }

export const buildInfo = __OPENPLOD_BUILD__
export const buildLabel = new Date(buildInfo.builtAt).toLocaleString(undefined, {
  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
})
