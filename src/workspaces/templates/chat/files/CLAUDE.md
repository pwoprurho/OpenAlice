# Chat workspace

This workspace is wired to OpenAlice via MCP. `.mcp.json` points at
OpenAlice's MCP server (`http://127.0.0.1:47332/mcp` by default, or
`$OPENALICE_MCP_URL`). The full OpenAlice tool surface — trading, market
data, news, indicators — is available from inside here.

To verify the wiring on first attach:

1. Approve the MCP server when Claude Code prompts for trust
2. Run `/mcp` — you should see `openalice · ✓ connected`
3. Ask Claude to "list tools" — it should enumerate OpenAlice's tools

Otherwise, use this workspace however you like. The CWD is its own git
repo (commits stay local), and any files you create or edit are scoped
to this workspace.
