import { randomInt, randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { attachWebSocketKeepalive } from "./websocket-keepalive";

const PORT = Number(process.env.WS_PORT ?? 3001);
const MAX_PLAYERS = 3;
const TILES_PER_PLAYER = 5;
const QUESTION_SLOTS = 6;
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

type TileColor = "red" | "blue" | "yellow";
type Tile = { id: string; number: number; color: TileColor };
type Phase = "lobby" | "playing" | "finished";
type PlayerStatus = "playing" | "solved" | "eliminated";

type Player = {
  id: string;
  name: string;
  sessionToken: string;
  socket: WebSocket;
  isReady: boolean;
  tiles: Tile[];
  status: PlayerStatus;
};

type QuestionKind =
  | "red-count"
  | "blue-count"
  | "red-sum"
  | "blue-sum"
  | "total-sum"
  | "middle-three-sum"
  | "largest-three-sum"
  | "smallest-three-sum"
  | "range-difference"
  | "same-number-pairs"
  | "odd-count"
  | "even-count"
  | "center-number-threshold"
  | "consecutive-positions"
  | "adjacent-same-color-positions"
  | "number-position";

type QuestionCard = {
  id: string;
  text: string;
  kind: QuestionKind;
  shared: boolean;
  number?: number;
  choices?: number[];
};

type QuestionResponse = { playerId: string; playerName: string; answer: string };

type QuestionExchange = {
  id: string;
  turn: number;
  actorId: string;
  actorName: string;
  text: string;
  shared: boolean;
  responses: QuestionResponse[];
};

type RankingEntry = {
  playerId: string;
  name: string;
  place: number;
  result: "correct" | "incorrect";
};

type Room = {
  code: string;
  players: Player[];
  /** Stable host identity; the host does not change when the turn order is rearranged. */
  hostPlayerId: string;
  /** Player IDs in the selected turn order, from first turn to last. */
  turnOrder: string[];
  phase: Phase;
  centerTiles: Tile[];
  questionDeck: QuestionCard[];
  questionCards: QuestionCard[];
  currentPlayerId: string | null;
  turnNumber: number;
  lastExchange: QuestionExchange | null;
  solvedOrder: string[];
  eliminationOrder: string[];
};

type Membership = { roomCode: string; playerId: string };

const rooms = new Map<string, Room>();
const memberships = new Map<WebSocket, Membership>();
const disconnectedPlayerTimers = new Map<string, ReturnType<typeof setTimeout>>();
const configuredGracePeriod = Number(process.env.WS_DISCONNECT_GRACE_MS ?? 90_000);
const DISCONNECT_GRACE_MS = Number.isFinite(configuredGracePeriod) && configuredGracePeriod >= 10_000
  ? configuredGracePeriod
  : 90_000;
const wss = new WebSocketServer({ host: "0.0.0.0", port: PORT });

// Official card prompts transcribed from the supplied Tagiron print-and-play PDF.
// Only the three cards labelled "共有情報カード" make the asker answer too.
const QUESTION_DEFINITIONS: QuestionCard[] = [
  { id: "red-sum", text: "赤の数の合計数は？", kind: "red-sum", shared: false },
  { id: "range-difference", text: "数字タイルの最大の数から最小の数を引いた数は？", kind: "range-difference", shared: true },
  { id: "red-count", text: "赤の数字タイルは何枚ある？", kind: "red-count", shared: false },
  { id: "largest-three-sum", text: "大きいほうから3枚の合計数は？", kind: "largest-three-sum", shared: false },
  { id: "same-number-pairs", text: "同じ数字タイルのペアは何組ある？", kind: "same-number-pairs", shared: false },
  { id: "smallest-three-sum", text: "小さいほうから3枚の合計数は？", kind: "smallest-three-sum", shared: false },
  { id: "consecutive-positions", text: "連番になっているタイルはどこ？", kind: "consecutive-positions", shared: false },
  { id: "position-5", text: "5はどこ？", kind: "number-position", shared: false, number: 5 },
  { id: "position-8-or-9", text: "8または9はどこ？（どちらかひとつ選択）", kind: "number-position", shared: false, choices: [8, 9] },
  { id: "blue-sum", text: "青の数の合計数は？", kind: "blue-sum", shared: false },
  { id: "center-number-threshold", text: "中央の数字タイルは5以上？4以下？", kind: "center-number-threshold", shared: true },
  { id: "position-1-or-2", text: "1または2はどこ？（どちらかひとつ選択）", kind: "number-position", shared: false, choices: [1, 2] },
  { id: "blue-count", text: "青の数字タイルは何枚ある？", kind: "blue-count", shared: false },
  { id: "even-count", text: "偶数は何枚ある？（0も含む）", kind: "even-count", shared: false },
  { id: "odd-count", text: "奇数は何枚ある？", kind: "odd-count", shared: false },
  { id: "adjacent-same-color-positions", text: "連続して隣り合っている同じ色はどこ？", kind: "adjacent-same-color-positions", shared: false },
  { id: "total-sum", text: "タイルすべての合計数は？", kind: "total-sum", shared: true },
  { id: "position-3-or-4", text: "3または4はどこ？（どちらかひとつ選択）", kind: "number-position", shared: false, choices: [3, 4] },
  { id: "position-6-or-7", text: "6または7はどこ？（どちらかひとつ選択）", kind: "number-position", shared: false, choices: [6, 7] },
  { id: "position-0", text: "0はどこ？", kind: "number-position", shared: false, number: 0 },
  { id: "middle-three-sum", text: "中央の3枚の合計数は？", kind: "middle-three-sum", shared: false },
];

function send(socket: WebSocket, type: string, payload: unknown = {}) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type, payload }));
  }
}

function sendError(socket: WebSocket, message: string) {
  send(socket, "system:error", { message });
}

function getPlayerName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  const length = Array.from(name).length;
  return length >= 1 && length <= 12 ? name : null;
}

function generateRoomCode(): string {
  let code = "";
  do {
    code = Array.from({ length: 6 }, () =>
      ROOM_CODE_CHARS.charAt(randomInt(ROOM_CODE_CHARS.length)),
    ).join("");
  } while (rooms.has(code));
  return code;
}

function createTileDeck(): Tile[] {
  const deck: Tile[] = [];
  for (let number = 0; number <= 4; number += 1) {
    deck.push({ id: `red-${number}`, number, color: "red" });
    deck.push({ id: `blue-${number}`, number, color: "blue" });
  }
  // The two 5 tiles are both yellow.
  deck.push({ id: "yellow-5-a", number: 5, color: "yellow" });
  deck.push({ id: "yellow-5-b", number: 5, color: "yellow" });
  for (let number = 6; number <= 9; number += 1) {
    deck.push({ id: `red-${number}`, number, color: "red" });
    deck.push({ id: `blue-${number}`, number, color: "blue" });
  }
  return deck;
}

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function sortTiles(tiles: Tile[]): Tile[] {
  const colorOrder: Record<TileColor, number> = { red: 0, yellow: 1, blue: 2 };
  return [...tiles].sort(
    (a, b) => a.number - b.number || colorOrder[a.color] - colorOrder[b.color],
  );
}

function getPublicPlayers(room: Room) {
  const playersById = new Map(room.players.map((player) => [player.id, player]));
  return room.turnOrder.flatMap((playerId) => {
    const player = playersById.get(playerId);
    if (!player) return [];
    return [{
      id: player.id,
      name: player.name,
      isHost: player.id === room.hostPlayerId,
      isReady: player.isReady,
      status: player.status,
    }];
  });
}

function broadcastRoom(room: Room) {
  const players = getPublicPlayers(room);
  for (const player of room.players) {
    send(player.socket, "room:updated", {
      roomCode: room.code,
      players,
      maxPlayers: MAX_PLAYERS,
      phase: room.phase,
    });
  }
}

function getRanking(room: Room): RankingEntry[] {
  const byId = new Map(room.players.map((player) => [player.id, player]));
  const orderedIds = [
    ...room.solvedOrder,
    // Players who were eliminated later rank above players eliminated earlier.
    ...[...room.eliminationOrder].reverse(),
  ];
  return orderedIds.flatMap((id, index) => {
    const player = byId.get(id);
    if (!player) return [];
    return [{
      playerId: player.id,
      name: player.name,
      place: index + 1,
      result: player.status === "solved" ? "correct" as const : "incorrect" as const,
    }];
  });
}

function sendGameState(room: Room, first = false) {
  const players = getPublicPlayers(room);
  const ranking = room.phase === "finished" ? getRanking(room) : [];

  for (const player of room.players) {
    const payload = {
      roomCode: room.code,
      phase: room.phase,
      players,
      ownTiles: player.tiles,
      ownStatus: player.status,
      centerTileCount: room.centerTiles.length,
      // Hidden information is disclosed only after the game has finished.
      ...(room.phase === "finished"
        ? {
            centerTiles: room.centerTiles,
            revealedHands: room.turnOrder.flatMap((playerId) => {
              const member = room.players.find((candidate) => candidate.id === playerId);
              return member ? [{
                playerId: member.id,
                playerName: member.name,
                tiles: member.tiles,
              }] : [];
            }),
          }
        : {}),
      questionCards: room.questionCards,
      currentPlayerId: room.currentPlayerId,
      turnNumber: room.turnNumber,
      lastExchange: room.lastExchange,
      ranking,
    };
    send(player.socket, first ? "game:started" : "game:state", payload);
  }
}

function refillQuestionCards(room: Room) {
  while (room.questionCards.length < QUESTION_SLOTS && room.questionDeck.length > 0) {
    room.questionCards.push(room.questionDeck.shift()!);
  }
}

function resetGame(room: Room) {
  room.phase = "lobby";
  room.centerTiles = [];
  room.questionDeck = [];
  room.questionCards = [];
  room.currentPlayerId = null;
  room.turnNumber = 0;
  room.lastExchange = null;
  room.solvedOrder = [];
  room.eliminationOrder = [];
  for (const player of room.players) {
    player.isReady = false;
    player.tiles = [];
    player.status = "playing";
  }
}

function clearDisconnectedPlayerTimer(playerId: string) {
  const timer = disconnectedPlayerTimers.get(playerId);
  if (timer) clearTimeout(timer);
  disconnectedPlayerTimers.delete(playerId);
}

function findPlayerBySessionToken(token: string): { room: Room; player: Player } | null {
  for (const room of rooms.values()) {
    const player = room.players.find((candidate) => candidate.sessionToken === token);
    if (player) return { room, player };
  }
  return null;
}

function scheduleDisconnectedPlayerRemoval(socket: WebSocket, membership: Membership) {
  const room = rooms.get(membership.roomCode);
  const player = room?.players.find((candidate) => candidate.id === membership.playerId);
  if (!room || !player || player.socket !== socket) return;

  clearDisconnectedPlayerTimer(player.id);
  const timer = setTimeout(() => {
    disconnectedPlayerTimers.delete(player.id);
    const currentRoom = rooms.get(membership.roomCode);
    const currentPlayer = currentRoom?.players.find((candidate) => candidate.id === membership.playerId);
    // A successful resume replaces player.socket, so an old timer cannot remove that player.
    if (!currentRoom || !currentPlayer || currentPlayer.socket !== socket || memberships.has(socket)) return;

    console.log(`プレイヤー ${currentPlayer.name} の再接続猶予が切れました`);
    // Reuse the normal removal path so existing lobby/game cleanup rules remain intact.
    memberships.set(socket, membership);
    removePlayer(socket, false);
  }, DISCONNECT_GRACE_MS);
  timer.unref?.();
  disconnectedPlayerTimers.set(player.id, timer);
  console.log(`プレイヤー ${player.name} の再接続を ${Math.round(DISCONNECT_GRACE_MS / 1000)} 秒待ちます`);
}

function handleSessionResume(socket: WebSocket, payload: Record<string, unknown>) {
  const token = typeof payload.token === "string" ? payload.token : "";
  if (!token) {
    send(socket, "session:resume:failed", { reason: "missing-token" });
    return;
  }

  const found = findPlayerBySessionToken(token);
  if (!found) {
    send(socket, "session:resume:failed", { reason: "session-not-found" });
    return;
  }

  const { room, player } = found;
  clearDisconnectedPlayerTimer(player.id);

  const previousSocket = player.socket;
  if (previousSocket !== socket) {
    memberships.delete(previousSocket);
    if (previousSocket.readyState === WebSocket.OPEN) {
      try {
        previousSocket.close(4001, "Session resumed on a new connection");
      } catch {
        // A stale connection may already be closed.
      }
    }
  }

  player.socket = socket;
  memberships.set(socket, { roomCode: room.code, playerId: player.id });
  send(socket, "session:resumed", {
    roomCode: room.code,
    playerId: player.id,
    phase: room.phase,
  });
  broadcastRoom(room);
  if (room.phase !== "lobby") sendGameState(room);
  console.log(`${player.name} がルーム ${room.code} に再接続しました`);
}

function removePlayer(socket: WebSocket, notifyClient: boolean) {
  const membership = memberships.get(socket);
  if (!membership) {
    if (notifyClient) send(socket, "room:left");
    return;
  }

  memberships.delete(socket);
  clearDisconnectedPlayerTimer(membership.playerId);
  const room = rooms.get(membership.roomCode);
  if (notifyClient) send(socket, "room:left");
  if (!room) return;

  const wasGame = room.phase === "playing" || room.phase === "finished";
  room.players = room.players.filter((player) => player.id !== membership.playerId);
  room.turnOrder = room.turnOrder.filter((playerId) => playerId !== membership.playerId);
  if (room.hostPlayerId === membership.playerId && room.players.length > 0) {
    room.hostPlayerId = room.turnOrder[0] ?? room.players[0]?.id ?? "";
  }

  if (room.players.length === 0) {
    rooms.delete(room.code);
    console.log(`ルーム ${room.code} を削除しました`);
    return;
  }

  if (wasGame) {
    resetGame(room);
    for (const player of room.players) {
      send(player.socket, "game:ended", {
        message: "プレイヤーが退出したため、待機ルームに戻りました。",
      });
    }
  }
  broadcastRoom(room);
}

function startGame(room: Room) {
  const deck = shuffle(createTileDeck());
  for (const player of room.players) {
    player.tiles = sortTiles(deck.splice(0, TILES_PER_PLAYER));
    player.status = "playing";
    player.isReady = false;
  }
  room.centerTiles = sortTiles(deck);

  const questions = shuffle(QUESTION_DEFINITIONS.map((card) => ({ ...card })));
  room.questionCards = questions.splice(0, QUESTION_SLOTS);
  room.questionDeck = questions;
  room.phase = "playing";
  room.currentPlayerId = room.turnOrder[0] ?? null;
  room.turnNumber = 1;
  room.lastExchange = null;
  room.solvedOrder = [];
  room.eliminationOrder = [];

  broadcastRoom(room);
  sendGameState(room, true);
  console.log(`ルーム ${room.code} でゲームを開始しました`);
}

function getAnswer(card: QuestionCard, player: Player): string {
  const hand = sortTiles(player.tiles);
  const count = (color: TileColor) => hand.filter((tile) => tile.color === color).length;
  const sum = (tiles: Tile[]) => tiles.reduce((total, tile) => total + tile.number, 0);
  const formatRanges = (ranges: Array<[number, number]>) =>
    ranges.length === 0
      ? "なし"
      : ranges.map(([start, end]) => `左から${start}〜${end}番目`).join("、");

  switch (card.kind) {
    case "red-count": return `${count("red")}枚`;
    case "blue-count": return `${count("blue")}枚`;
    case "red-sum": return String(sum(hand.filter((tile) => tile.color === "red")));
    case "blue-sum": return String(sum(hand.filter((tile) => tile.color === "blue")));
    case "total-sum": return String(sum(hand));
    case "range-difference": return String(hand[hand.length - 1].number - hand[0].number);
    case "largest-three-sum": return String(sum(hand.slice(-3)));
    case "smallest-three-sum": return String(sum(hand.slice(0, 3)));
    case "middle-three-sum": return String(sum(hand.slice(1, 4)));
    case "same-number-pairs": {
      const counts = new Map<number, number>();
      for (const tile of hand) counts.set(tile.number, (counts.get(tile.number) ?? 0) + 1);
      const pairs = [...counts.values()].reduce((total, numberCount) => total + numberCount * (numberCount - 1) / 2, 0);
      return `${pairs}組`;
    }
    case "odd-count": return `${hand.filter((tile) => tile.number % 2 !== 0).length}枚`;
    case "even-count": return `${hand.filter((tile) => tile.number % 2 === 0).length}枚`;
    case "center-number-threshold": return hand[2].number >= 5 ? "5以上" : "4以下";
    case "consecutive-positions": {
      const ranges: Array<[number, number]> = [];
      let index = 0;
      while (index < hand.length - 1) {
        if (hand[index + 1].number === hand[index].number + 1) {
          const start = index;
          let end = index + 1;
          while (end < hand.length - 1 && hand[end + 1].number === hand[end].number + 1) end += 1;
          ranges.push([start + 1, end + 1]);
          index = end + 1;
        } else {
          index += 1;
        }
      }
      return formatRanges(ranges);
    }
    case "adjacent-same-color-positions": {
      const ranges: Array<[number, number]> = [];
      let index = 0;
      while (index < hand.length - 1) {
        if (hand[index + 1].color === hand[index].color) {
          const start = index;
          let end = index + 1;
          while (end < hand.length - 1 && hand[end + 1].color === hand[end].color) end += 1;
          ranges.push([start + 1, end + 1]);
          index = end + 1;
        } else {
          index += 1;
        }
      }
      return formatRanges(ranges);
    }
    case "number-position": {
      if (card.number === undefined) return "数字の選択がありません";
      const positions = hand.flatMap((tile, index) => tile.number === card.number ? [index + 1] : []);
      if (positions.length === 0) return "持っていない";
      return positions.map((position) => `左から${position}番目`).join("・");
    }
  }
}

function getActivePlayers(room: Room): Player[] {
  return room.players.filter((player) => player.status === "playing");
}

function finishGame(room: Room) {
  room.phase = "finished";
  room.currentPlayerId = null;
  broadcastRoom(room);
  sendGameState(room);
  console.log(`ルーム ${room.code} のゲームが終了しました`);
}

function advanceTurn(room: Room, previousPlayerId: string) {
  const active = getActivePlayers(room);
  if (active.length === 0) {
    finishGame(room);
    return;
  }

  const order = room.turnOrder;
  const previousIndex = order.indexOf(previousPlayerId);
  if (previousIndex < 0 || order.length === 0) {
    finishGame(room);
    return;
  }
  const playersById = new Map(room.players.map((player) => [player.id, player]));
  for (let offset = 1; offset <= order.length; offset += 1) {
    const candidateId = order[(previousIndex + offset) % order.length];
    const candidate = candidateId ? playersById.get(candidateId) : undefined;
    if (candidate?.status === "playing") {
      room.currentPlayerId = candidate.id;
      room.turnNumber += 1;
      sendGameState(room);
      return;
    }
  }

  finishGame(room);
}

function getPlayerForSocket(socket: WebSocket): { room: Room; player: Player } | null {
  const membership = memberships.get(socket);
  if (!membership) return null;
  const room = rooms.get(membership.roomCode);
  const player = room?.players.find((candidate) => candidate.id === membership.playerId);
  if (!room || !player) return null;
  return { room, player };
}

function isValidGuess(value: unknown): Tile[] | null {
  if (!Array.isArray(value) || value.length !== TILES_PER_PLAYER) return null;
  const tiles: Tile[] = [];
  const counts = new Map<string, number>();

  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const candidate = item as Record<string, unknown>;
    if (!Number.isInteger(candidate.number) || typeof candidate.color !== "string") return null;
    const number = candidate.number as number;
    const color = candidate.color;
    if (number < 0 || number > 9) return null;
    if (color !== "red" && color !== "blue" && color !== "yellow") return null;
    if (number === 5 ? color !== "yellow" : color === "yellow") return null;

    const key = `${color}-${number}`;
    const nextCount = (counts.get(key) ?? 0) + 1;
    const allowed = color === "yellow" && number === 5 ? 2 : 1;
    if (nextCount > allowed) return null;
    counts.set(key, nextCount);
    tiles.push({ id: key, number, color });
  }

  return sortTiles(tiles);
}

function sameTiles(first: Tile[], second: Tile[]) {
  const a = sortTiles(first);
  const b = sortTiles(second);
  return a.length === b.length && a.every(
    (tile, index) => tile.number === b[index].number && tile.color === b[index].color,
  );
}

wss.on("connection", (socket) => {
  attachWebSocketKeepalive(socket);
  console.log("クライアントが接続しました");
  send(socket, "system:connected", { message: "WebSocket connected" });

  socket.on("message", (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      sendError(socket, "メッセージの形式が正しくありません");
      return;
    }

    if (typeof parsed !== "object" || parsed === null) {
      sendError(socket, "メッセージの形式が正しくありません");
      return;
    }
    const message = parsed as Record<string, unknown>;
    if (typeof message.type !== "string") {
      sendError(socket, "メッセージの種類が指定されていません");
      return;
    }
    const payload = typeof message.payload === "object" && message.payload !== null
      ? message.payload as Record<string, unknown>
      : {};

    switch (message.type) {
      case "ping": {
        // attachWebSocketKeepalive handles this heartbeat and replies with `pong`.
        // Keep it out of the gameplay command handlers.
        break;
      }

      case "pong": {
        // Reserved for clients that echo application-level heartbeat responses.
        break;
      }

      case "session:resume": {
        handleSessionResume(socket, payload);
        break;
      }

      case "room:create": {
        if (memberships.has(socket)) {
          sendError(socket, "すでにルームに参加しています");
          break;
        }
        const name = getPlayerName(payload.name);
        if (!name) {
          sendError(socket, "プレイヤー名は1〜12文字で入力してください");
          break;
        }
        const code = generateRoomCode();
        const player: Player = {
          id: randomUUID(), name, sessionToken: randomUUID(), socket,
          isReady: false, tiles: [], status: "playing",
        };
        const room: Room = {
          code, players: [player], hostPlayerId: player.id, turnOrder: [player.id],
          phase: "lobby", centerTiles: [], questionDeck: [], questionCards: [],
          currentPlayerId: null, turnNumber: 0, lastExchange: null,
          solvedOrder: [], eliminationOrder: [],
        };
        rooms.set(code, room);
        memberships.set(socket, { roomCode: code, playerId: player.id });
        send(socket, "room:created", { roomCode: code, playerId: player.id, token: player.sessionToken });
        broadcastRoom(room);
        console.log(`${name} がルーム ${code} を作成しました`);
        break;
      }

      case "room:join": {
        if (memberships.has(socket)) {
          sendError(socket, "すでにルームに参加しています");
          break;
        }
        const name = getPlayerName(payload.name);
        const code = typeof payload.roomCode === "string" ? payload.roomCode.trim().toUpperCase() : "";
        if (!name) {
          sendError(socket, "プレイヤー名は1〜12文字で入力してください");
          break;
        }
        const room = rooms.get(code);
        if (!room) {
          sendError(socket, "ルームが見つかりません");
          break;
        }
        if (room.phase !== "lobby") {
          sendError(socket, "このゲームはすでに開始しています");
          break;
        }
        if (room.players.length >= MAX_PLAYERS) {
          sendError(socket, "このルームは満員です");
          break;
        }
        const player: Player = {
          id: randomUUID(), name, sessionToken: randomUUID(), socket,
          isReady: false, tiles: [], status: "playing",
        };
        room.players.push(player);
        room.turnOrder.push(player.id);
        memberships.set(socket, { roomCode: code, playerId: player.id });
        send(socket, "room:joined", { roomCode: code, playerId: player.id, token: player.sessionToken });
        broadcastRoom(room);
        console.log(`${name} がルーム ${code} に参加しました`);
        break;
      }

      case "room:set-order": {
        const membership = memberships.get(socket);
        const room = membership ? rooms.get(membership.roomCode) : undefined;
        if (!membership || !room) {
          sendError(socket, "先にルームへ参加してください");
          break;
        }
        if (room.phase !== "lobby") {
          sendError(socket, "ゲーム開始後は手番順を変更できません");
          break;
        }
        if (room.hostPlayerId !== membership.playerId) {
          sendError(socket, "手番順を変更できるのはホストだけです");
          break;
        }
        if (room.players.length !== MAX_PLAYERS) {
          sendError(socket, "3人そろってから手番順を変更してください");
          break;
        }
        const proposedOrder = payload.playerIds;
        const currentIds = new Set(room.players.map((player) => player.id));
        if (
          !Array.isArray(proposedOrder) ||
          proposedOrder.length !== room.players.length ||
          proposedOrder.some((id) => typeof id !== "string" || !currentIds.has(id)) ||
          new Set(proposedOrder).size !== room.players.length
        ) {
          sendError(socket, "手番順の指定が正しくありません");
          break;
        }
        room.turnOrder = [...proposedOrder] as string[];
        broadcastRoom(room);
        break;
      }

      case "room:ready": {
        const membership = memberships.get(socket);
        const room = membership ? rooms.get(membership.roomCode) : undefined;
        if (!membership || !room) {
          sendError(socket, "先にルームへ参加してください");
          break;
        }
        if (room.phase !== "lobby") {
          sendError(socket, "ゲーム開始後は準備状態を変更できません");
          break;
        }
        if (typeof payload.isReady !== "boolean") {
          sendError(socket, "準備状態が正しくありません");
          break;
        }
        const player = room.players.find((candidate) => candidate.id === membership.playerId);
        if (!player) {
          sendError(socket, "プレイヤー情報が見つかりません");
          break;
        }
        player.isReady = payload.isReady;
        broadcastRoom(room);
        break;
      }

      case "game:start": {
        const membership = memberships.get(socket);
        const room = membership ? rooms.get(membership.roomCode) : undefined;
        if (!membership || !room) {
          sendError(socket, "先にルームへ参加してください");
          break;
        }
        if (room.phase !== "lobby") {
          sendError(socket, "ゲームはすでに開始しています");
          break;
        }
        if (room.hostPlayerId !== membership.playerId) {
          sendError(socket, "ゲームを開始できるのはホストだけです");
          break;
        }
        if (room.players.length !== MAX_PLAYERS) {
          sendError(socket, "3人そろってからゲームを開始してください");
          break;
        }
        if (!room.players.every((player) => player.isReady)) {
          sendError(socket, "全員が準備完了してから開始してください");
          break;
        }
        startGame(room);
        break;
      }

      case "game:ask-question": {
        const found = getPlayerForSocket(socket);
        if (!found) {
          sendError(socket, "ルームに参加してください");
          break;
        }
        const { room, player } = found;
        if (room.phase !== "playing") {
          sendError(socket, "ゲーム中ではありません");
          break;
        }
        if (room.currentPlayerId !== player.id || player.status !== "playing") {
          sendError(socket, "あなたの手番ではありません");
          break;
        }
        const cardId = typeof payload.cardId === "string" ? payload.cardId : "";
        const cardIndex = room.questionCards.findIndex((card) => card.id === cardId);
        if (cardIndex < 0) {
          sendError(socket, "その質問カードは場にありません");
          break;
        }

        const card = room.questionCards[cardIndex];
        let askedCard = card;
        let questionText = card.text;
        if (card.choices) {
          const choiceNumber = payload.choiceNumber;
          if (!Number.isInteger(choiceNumber) || !card.choices.includes(choiceNumber as number)) {
            sendError(socket, "この質問カードで選べる数字を選択してください");
            break;
          }
          askedCard = { ...card, number: choiceNumber as number };
          questionText = `${card.text}〔${choiceNumber}を選択〕`;
        }
        room.questionCards.splice(cardIndex, 1);
        const targets = card.shared ? room.players : room.players.filter((other) => other.id !== player.id);
        const responses = targets.map((target) => ({
          playerId: target.id,
          playerName: target.name,
          answer: getAnswer(askedCard, target),
        }));
        room.lastExchange = {
          id: randomUUID(),
          turn: room.turnNumber,
          actorId: player.id,
          actorName: player.name,
          text: questionText,
          shared: card.shared,
          responses,
        };
        refillQuestionCards(room);
        advanceTurn(room, player.id);
        break;
      }

      case "game:guess": {
        const found = getPlayerForSocket(socket);
        if (!found) {
          sendError(socket, "ルームに参加してください");
          break;
        }
        const { room, player } = found;
        if (room.phase !== "playing") {
          sendError(socket, "ゲーム中ではありません");
          break;
        }
        if (room.currentPlayerId !== player.id || player.status !== "playing") {
          sendError(socket, "あなたの手番ではありません");
          break;
        }
        const guess = isValidGuess(payload.tiles);
        if (!guess) {
          sendError(socket, "宣言は、有効な数字・色のタイルを5枚選んでください。同じタイルは重複できません（黄色の5のみ2枚まで）。");
          break;
        }
        const correct = sameTiles(guess, room.centerTiles);
        player.status = correct ? "solved" : "eliminated";
        if (correct) room.solvedOrder.push(player.id);
        else room.eliminationOrder.push(player.id);
        advanceTurn(room, player.id);
        break;
      }

      case "game:return-lobby": {
        const found = getPlayerForSocket(socket);
        if (!found) {
          sendError(socket, "ルームに参加していません");
          break;
        }
        const { room, player } = found;
        if (room.phase !== "finished") {
          sendError(socket, "ゲーム結果画面でのみロビーに戻れます");
          break;
        }
        if (room.hostPlayerId !== player.id) {
          sendError(socket, "次の行き先を選べるのはホストだけです");
          break;
        }

        resetGame(room);
        for (const member of room.players) {
          send(member.socket, "game:returned-lobby", {
            message: "ホストがロビーに戻りました。準備完了を押してください。",
          });
        }
        broadcastRoom(room);
        console.log(`ルーム ${room.code} はホストによりロビーへ戻りました`);
        break;
      }

      case "game:return-home": {
        const found = getPlayerForSocket(socket);
        if (!found) {
          sendError(socket, "ルームに参加していません");
          break;
        }
        const { room, player } = found;
        if (room.phase !== "finished") {
          sendError(socket, "ゲーム結果画面でのみホームに戻れます");
          break;
        }
        if (room.hostPlayerId !== player.id) {
          sendError(socket, "次の行き先を選べるのはホストだけです");
          break;
        }

        // ホストがホームを選んだら、ルームを閉じて全員を同時にホームへ戻す。
        for (const member of [...room.players]) {
          clearDisconnectedPlayerTimer(member.id);
          memberships.delete(member.socket);
          send(member.socket, "room:left", { reason: "host-return-home" });
        }
        rooms.delete(room.code);
        console.log(`ルーム ${room.code} はホストにより終了しました`);
        break;
      }

      case "room:leave": {
        removePlayer(socket, true);
        break;
      }

      default: {
        sendError(socket, "未対応のメッセージです");
      }
    }
  });

  socket.on("close", () => {
    console.log("クライアントが切断しました");
    const membership = memberships.get(socket);
    if (!membership) return; // A previous socket may close after the session resumed elsewhere.
    memberships.delete(socket);
    scheduleDisconnectedPlayerRemoval(socket, membership);
  });
  socket.on("error", (error) => console.error("WebSocketエラー:", error));
});

wss.on("listening", () => console.log(`WebSocket server listening on port ${PORT}`));
wss.on("error", (error) => console.error("サーバー起動エラー:", error));
