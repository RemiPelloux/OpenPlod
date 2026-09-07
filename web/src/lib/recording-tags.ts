export function addRecordingTags(existing: string[], input: string): string[] {
  const tags = [...existing]
  const known = new Set(tags.map(tag => tag.toLocaleLowerCase()))
  for (const value of input.split(',')) {
    const tag = value.trim()
    if (tag && !known.has(tag.toLocaleLowerCase())) {
      tags.push(tag)
      known.add(tag.toLocaleLowerCase())
    }
  }
  return tags
}
