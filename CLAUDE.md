# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Multi-player synchronized lottery system (多人同步抽奖系统). All connected browser clients stay in sync via WebSocket. The server is the single source of truth for draw state.

## Commands

```bash
npm install          # Install dependencies (express, ws)
node server.js       # Start server on http://localhost:3000
npm start            # Same as node server.js
```

No build step, no test framework, no linter configured.

## Architecture

**Single-file backend** (`server.js`): Express serves static files from `public/`, WebSocket (ws) handles real-time draw logic. State persisted to `state.json` with atomic writes (tmp file + rename) and automatic `.bak` backup.

**Two frontend pages**:
- `public/index.html` + `public/script.js` — Main draw page (IIFE). WebSocket, name-rolling animation, fireworks canvas, background music.
- `public/admin.html` (inline `<script>`) — Admin panel for prize configuration, participant list, and reset. Shares the same WebSocket protocol.

Both pages share `public/style.css`.

### Key data flow

1. Client sends `{ type: 'draw', prizeName }` over WebSocket
2. Server acquires a global mutex lock (serializes ALL state mutations), picks random winner(s) from candidates, updates `state.json`, broadcasts `drawResult` to all clients
3. Only the initiating client plays animations (fireworks, winner modal); other clients silently update state

### WebSocket message types

| Client → Server | Server → Client |
|---|---|
| `draw` (trigger draw) | `init` (full state on connect) |
| `updatePrizes` (reconfigure prizes) | `drawResult` (winners + state) |
| `reset` (clear all drawn records) | `prizesUpdated`, `resetDone` |
| | `error` (validation failures) |

### State shape (`state.json`)

```json
{
  "prizes": [
    { "name": "三等奖", "total": 3, "perDraw": 1, "drawn": [], "isConsolation": false }
  ],
  "history": [
    { "prizeName": "一等奖", "winners": ["张三"], "time": "2024-01-01T12:00:00.000Z" }
  ]
}
```

### Participant list (`public/data/list.json`)

`name` array with objects containing `name` and `dept` fields. `dept` is a region/office code (e.g., `"BJ"`, `"SD"`, `"HB"`, `"SC"`, `"GD"`, `"CN"`). `hqPool` is built from entries where `dept === 'CN'`; these names are excluded from non-consolation prize draws.

## Key implementation details

- **Concurrency control**: Global promise-chain mutex (`withLock`) serializes ALL state-modifying operations (draw, updatePrizes, reset).
- **Rate limiting**: Per-connection 2-second cooldown (`drawCooldowns` Map) prevents rapid-fire draw requests.
- **State persistence**: `saveState()` writes to `.tmp` then renames (atomic). Creates `state.json.bak` before each write. In-memory cache (`cachedState`) avoids redundant file reads.
- **Name list caching**: `loadNameList()` uses async file read with 3-second in-memory cache.
- **Candidate filtering**: All already-drawn names across every prize are excluded. `hqPool` (dept === 'CN') is additionally excluded from non-consolation prizes.
- **Draw history**: Each draw is recorded in `state.history` with prize name, winners, and ISO timestamp. Cleared on reset, preserved on prize config updates.
- **Export**: Client-side download of results as `.txt` file (summary + history). Available on both main and admin pages.
- **Frontend animation**: Rolling name display is purely client-side decoration (80ms interval via requestAnimationFrame). The actual winner is determined server-side; client animation stops on receiving `drawResult`. Initiator-only: only the client that triggered the draw plays fireworks/win sound/modal.
- **Auto-reconnect**: Exponential backoff (1s base, 30s cap) on disconnect.
- **WebSocket limits**: `maxPayload` set to 10KB.
- **REST endpoint**: `GET /api/names` returns `{ names }` (name list only, no dept info exposed).
- **Validation**: Server validates duplicate prize names, `perDraw <= total`, `drawn.length <= total`, and required fields on prize updates.
- **Startup recovery**: If `.tmp` file exists but `state.json` is missing (interrupted atomic write), the server renames `.tmp` to `state.json`.
