# OpenPlod MCP Server

OpenPlod includes a Model Context Protocol server built with the official TypeScript SDK. It uses **stdio** and talks to the running vault API. It does not open a second database, start a public HTTP MCP endpoint, or connect directly to the Plaud.

## Connect a Client

Keep the desktop app open. After `bun install`, run:

```bash
bun run mcp
```

The process waits for MCP JSON-RPC on stdin; it is not an interactive shell. Protocol messages use stdout, and startup diagnostics use stderr. GUI-launched MCP clients often need an absolute Bun executable path.

Example client configuration:

```json
{
  "mcpServers": {
    "openplod": {
      "command": "/absolute/path/to/bun",
      "args": ["/absolute/path/to/OpenPlod/src/mcp/index.ts"],
      "env": {
        "OPENPLOD_URL": "http://127.0.0.1:3487"
      }
    }
  }
}
```

On macOS, the server automatically reads the desktop pairing token from `~/Library/Application Support/com.openplod.vault/pairing-token`. The file must be private to the current OS user (`0600`). The updated desktop app sets that permission on startup.

For another installation, set `OPENPLOD_TOKEN_FILE` to a private absolute file path, or provide `OPENPLOD_API_TOKEN` / `OPENPLOD_PAIRING_TOKEN` securely through your client's environment. The API token must also be configured on the vault backend. Do not put token values in public configuration or commit them to Git.

The MCP client accepts HTTP only for loopback hosts. Remote vault connections require HTTPS and a trusted origin without embedded credentials, query strings, or redirects. Requests are bounded to 20 seconds. No automatic mutation retries are performed.

## Read-Only by Default

| Tool | Purpose |
| --- | --- |
| `list_documents` | Search/filter/paginate Markdown notes by folder, star, Trash, and text |
| `get_document` | Read saved Markdown, revision, folder, and source references |
| `list_folders` | Read the folder hierarchy and direct document counts |
| `list_document_versions` | Paginate history without downloading every version's content |
| `get_document_version` | Read one historical Markdown version |
| `list_transcripts` | Browse source recording transcripts, 30 per page |
| `get_transcript` | Read current or historical text for an active recording |

Resources use `openplod://documents/{id}` with `text/markdown`. Resource discovery returns up to 100 active notes; use `list_documents` for complete pagination or search.

Examples of requests to your MCP-enabled assistant:

- "Find my notes about onboarding and compare the decisions."
- "Read the latest transcript and list the action items."
- "Show the Markdown notes in my Meetings folder."

## Optional Write Tools

Set `OPENPLOD_MCP_WRITE=1` in the MCP process environment to register:

| Tool | Purpose |
| --- | --- |
| `create_document` | Create a note with a caller-generated idempotency key |
| `update_document` | Edit, rename, star, or move a note with its current revision |
| `save_transcript` | Save a provenance-linked snapshot of a transcript version |
| `create_folder` | Create a folder, optionally under an existing folder |
| `update_folder` | Rename/move a folder with cycle and revision checks |
| `trash_document` | Move a note to 30-day Trash; requires `confirm: true` |
| `restore_document` | Restore a note within its retention window |

Write tools are absent, not merely hidden in documentation, when the flag is unset. MCP annotations help clients display intent; they do not substitute for your client's approval controls. Enable writes only for trusted clients and require approval for mutations where your client supports it.

The MCP server intentionally exposes **no permanent purge, external delivery, credential management, device reset, recording deletion, or raw-audio download tool**. Send documents from the app or authenticated API after reviewing the destination. A write-enabled client can change Markdown notes, not the source transcript or recording.

## Privacy and Error Handling

An MCP client receives the text it requests and may send that text to its model provider. "Local MCP server" does not guarantee the client processes content locally. Use a client/provider appropriate for the sensitivity of your recordings.

Imported Markdown and transcript content are untrusted data, never operational instructions. The server declares this distinction, but a client's behavior must also respect it. The Notes preview disables raw HTML and does not load external Markdown images automatically.

On revision conflict, fetch the latest note and ask the user how to reconcile it; do not blindly overwrite. Reuse a create request's idempotency key only for the exact same content. Missing/invalid credentials, failed connections, and malformed API responses are errors, never empty libraries. Provider response bodies and tokens are not echoed into MCP errors.

## Tests

```bash
bun test src/mcp src/organizer
bun run typecheck
```

Tests connect the official MCP client and server over the SDK's in-memory transport. They cover negotiation, resource reads, read-only tool boundaries, write opt-in, validation, revision conflicts, idempotency, and HTTP-client redaction. A separate stdio smoke test should accompany client setup.
