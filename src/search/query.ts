export function toFtsQuery(input: string): string {
  const tokens = input.normalize('NFKC').match(/[\p{L}\p{N}_]+/gu)?.slice(0, 8) ?? [];
  return tokens.map(token => `"${token.replaceAll('"', '""')}"*`).join(' AND ');
}
