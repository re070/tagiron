"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { TagironWebSocketClient } from "@/lib/tagiron-websocket-client";
import styles from "./page.module.css";

type TileColor = "red" | "blue" | "yellow";
type Tile = { id: string; number: number; color: TileColor };
type PlayerStatus = "playing" | "solved" | "eliminated";
type PlayerSummary = {
  id: string;
  name: string;
  isHost: boolean;
  isReady: boolean;
  status: PlayerStatus;
};
type Phase = "lobby" | "playing" | "finished";
type Lobby = {
  roomCode: string;
  players: PlayerSummary[];
  maxPlayers: number;
  phase: Phase;
};
type QuestionCard = { id: string; text: string; shared: boolean; choices?: number[] };
type QuestionResponse = { playerId: string; playerName: string; answer: string };
type RankingEntry = {
  playerId: string;
  name: string;
  place: number;
  result: "correct" | "incorrect";
};
type QuestionExchange = {
  id: string;
  turn: number;
  actorId: string;
  actorName: string;
  text: string;
  shared: boolean;
  responses: QuestionResponse[];
};
type RevealedHand = {
  playerId: string;
  playerName: string;
  tiles: Tile[];
};
type GameView = {
  roomCode: string;
  phase: "playing" | "finished";
  players: PlayerSummary[];
  ownTiles: Tile[];
  ownStatus: PlayerStatus;
  centerTileCount: number;
  centerTiles?: Tile[];
  revealedHands?: RevealedHand[];
  questionCards: QuestionCard[];
  currentPlayerId: string | null;
  turnNumber: number;
  lastExchange: QuestionExchange | null;
  ranking: RankingEntry[];
};
type ServerMessage =
  | { type: "system:connected"; payload?: { message?: string } }
  | { type: "system:error"; payload?: { message?: string } }
  | { type: "room:created" | "room:joined"; payload: { roomCode: string; playerId: string; token?: string } }
  | { type: "session:resumed"; payload: { roomCode: string; playerId: string; phase?: Phase } }
  | { type: "session:resume:failed"; payload?: { reason?: string } }
  | { type: "room:updated"; payload: { roomCode: string; players: PlayerSummary[]; maxPlayers: number; phase: Phase } }
  | { type: "room:left"; payload?: { reason?: "host-return-home" } }
  | { type: "game:started" | "game:state"; payload: GameView }
  | { type: "game:returned-lobby"; payload?: { message?: string } }
  | { type: "game:ended"; payload?: { message?: string } };
type ClientMessage =
  | { type: "room:create"; payload: { name: string } }
  | { type: "room:join"; payload: { name: string; roomCode: string } }
  | { type: "room:ready"; payload: { isReady: boolean } }
  | { type: "room:set-order"; payload: { playerIds: string[] } }
  | { type: "game:start"; payload: Record<string, never> }
  | { type: "game:ask-question"; payload: { cardId: string; choiceNumber?: number } }
  | { type: "game:guess"; payload: { tiles: { number: number; color: TileColor }[] } }
  | { type: "game:return-lobby"; payload: Record<string, never> }
  | { type: "game:return-home"; payload: Record<string, never> }
  | { type: "room:leave"; payload: Record<string, never> };
type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "disconnected";
type GuessOption = { key: string; number: number; color: TileColor; label: string };

const guessOptions: GuessOption[] = [
  ...Array.from({ length: 5 }, (_, number) => [
    { key: `red:${number}`, number, color: "red" as const, label: `赤 ${number}` },
    { key: `blue:${number}`, number, color: "blue" as const, label: `青 ${number}` },
  ]).flat(),
  { key: "yellow:5:a", number: 5, color: "yellow", label: "黄 5（1枚目）" },
  { key: "yellow:5:b", number: 5, color: "yellow", label: "黄 5（2枚目）" },
  ...Array.from({ length: 4 }, (_, index) => index + 6).flatMap((number) => [
    { key: `red:${number}`, number, color: "red" as const, label: `赤 ${number}` },
    { key: `blue:${number}`, number, color: "blue" as const, label: `青 ${number}` },
  ]),
];

function colorName(color: TileColor) {
  return color === "red" ? "赤" : color === "blue" ? "青" : "黄";
}

function tileClass(color: TileColor) {
  return color === "red" ? styles.tileRed : color === "blue" ? styles.tileBlue : styles.tileYellow;
}

function playerStatusLabel(status: PlayerStatus) {
  if (status === "solved") return "正解・順位確定";
  if (status === "eliminated") return "宣言失敗・脱落";
  return "挑戦中";
}

export default function Home() {
  const socketRef = useRef<TagironWebSocketClient | null>(null);
  const bgmRef = useRef<HTMLAudioElement | null>(null);
  const [bgmVolume, setBgmVolume] = useState(0.35);
  const [bgmEnabled, setBgmEnabled] = useState(true);
  const [bgmNeedsGesture, setBgmNeedsGesture] = useState(false);
  const [bgmFileMissing, setBgmFileMissing] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [playerName, setPlayerName] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [playerId, setPlayerId] = useState("");
  const [lobby, setLobby] = useState<Lobby | null>(null);
  const [game, setGame] = useState<GameView | null>(null);
  const [notice, setNotice] = useState("");
  const [showGuessForm, setShowGuessForm] = useState(false);
  const [mobileGameTab, setMobileGameTab] = useState<"game" | "memo">("game");
  const [isMobileLayout, setIsMobileLayout] = useState(false);
  const [hasQuestionUpdate, setHasQuestionUpdate] = useState(false);
  const [remainingMemoTiles, setRemainingMemoTiles] = useState<string[]>([]);
  const mobileGameTabRef = useRef<"game" | "memo">("game");
  const isMobileLayoutRef = useRef(false);
  const lastExchangeIdRef = useRef<string | null>(null);
  const [guess, setGuess] = useState<string[]>(["red:0", "blue:1", "red:2", "blue:3", "yellow:5:a"]);

  // 候補タイルがちょうど5枚に絞られたら、中央の並び宣言へ自動反映する。
  const handleRemainingTilesChange = useCallback((tiles: string[]) => {
    setRemainingMemoTiles(tiles);
    if (tiles.length === 5) setGuess(tiles);
  }, []);

  // CSSのブレークポイントと切り替え処理を一致させる。
  // PCではゲームとメモを同時表示し、スマホ幅だけ選択中のパネルを表示する。
  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 900px)");
    const updateLayout = () => {
      isMobileLayoutRef.current = mediaQuery.matches;
      setIsMobileLayout(mediaQuery.matches);
    };
    updateLayout();
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", updateLayout);
      return () => mediaQuery.removeEventListener("change", updateLayout);
    }
    mediaQuery.addListener(updateLayout);
    return () => mediaQuery.removeListener(updateLayout);
  }, []);

  useEffect(() => {
    const client = new TagironWebSocketClient({
      onStatusChange: (status) => {
        if (status === "connected") {
          setConnectionStatus("connected");
          setNotice((current) =>
            current.startsWith("サーバーに接続できません") ||
            current.startsWith("サーバーとの接続が不安定")
              ? ""
              : current,
          );
          return;
        }
        if (status === "connecting") {
          setConnectionStatus("connecting");
          return;
        }
        if (status === "reconnecting") {
          setConnectionStatus("reconnecting");
          return;
        }
        setConnectionStatus("disconnected");
      },
      onError: () => {
        setNotice("サーバーとの接続が不安定です。自動的に再接続します。");
      },
      onMessage: (rawMessage) => {
        if (typeof rawMessage !== "object" || rawMessage === null) {
          setNotice("サーバーからのメッセージを読み取れませんでした");
          return;
        }

        const message = rawMessage as ServerMessage;
        switch (message.type) {
          case "system:connected":
            setConnectionStatus("connected");
            break;
          case "system:error":
            setNotice(message.payload?.message ?? "エラーが発生しました");
            break;
          case "room:created":
          case "room:joined": {
            setPlayerId(message.payload.playerId);
            if (message.payload.token) {
              client.setResumePayload({
                token: message.payload.token,
                roomCode: message.payload.roomCode,
                playerId: message.payload.playerId,
              });
            }
            setLobby({ roomCode: message.payload.roomCode, players: [], maxPlayers: 3, phase: "lobby" });
            setGame(null);
            setShowGuessForm(false);
            setNotice(message.type === "room:created" ? "ルームを作成しました" : "ルームに参加しました");
            break;
          }
          case "session:resumed":
            setPlayerId(message.payload.playerId);
            setLobby((current) => current?.roomCode === message.payload.roomCode
              ? current
              : { roomCode: message.payload.roomCode, players: [], maxPlayers: 3, phase: message.payload.phase ?? "lobby" });
            setNotice(message.payload.phase && message.payload.phase !== "lobby"
              ? "接続が復旧しました。ゲーム状態を同期しています。"
              : "接続が復旧しました。");
            break;
          case "session:resume:failed":
            client.clearResumePayload();
            setPlayerId("");
            setLobby(null);
            setGame(null);
            setShowGuessForm(false);
            lastExchangeIdRef.current = null;
            setHasQuestionUpdate(false);
            setNotice("セッションを復旧できませんでした。サーバーが再起動した可能性があります。新しいルームを作成するか、既存のルームに参加してください。");
            break;
          case "room:updated":
            setLobby({
              roomCode: message.payload.roomCode,
              players: message.payload.players,
              maxPlayers: message.payload.maxPlayers,
              phase: message.payload.phase,
            });
            break;
          case "room:left":
            client.clearResumePayload();
            setLobby(null);
            setGame(null);
            setPlayerId("");
            setShowGuessForm(false);
            setNotice(
              message.payload?.reason === "host-return-home"
                ? "ホストがホームに戻ったため、ルームを終了しました。"
                : "ルームから退出しました",
            );
            break;
          case "game:started":
          case "game:state": {
            const incomingExchangeId = message.payload.lastExchange?.id ?? null;
            if (message.type === "game:started") {
              // 新しいゲームの最初の状態は通知対象にせず、以降の質問更新から追跡する。
              lastExchangeIdRef.current = incomingExchangeId;
              mobileGameTabRef.current = "game";
              setMobileGameTab("game");
              setHasQuestionUpdate(false);
            } else {
              // 推理メモを開いている間に質問・回答が更新されたら、ゲームタブに目印を出す。
              if (
                incomingExchangeId &&
                incomingExchangeId !== lastExchangeIdRef.current &&
                isMobileLayoutRef.current &&
                mobileGameTabRef.current === "memo"
              ) {
                setHasQuestionUpdate(true);
              }
              lastExchangeIdRef.current = incomingExchangeId;
            }
            setGame(message.payload);
            setShowGuessForm(false);
            if (message.payload.phase === "finished") setNotice("ゲームが終了しました。結果を確認してください。");
            else setNotice("");
            break;
          }
          case "game:returned-lobby":
            lastExchangeIdRef.current = null;
            setHasQuestionUpdate(false);
            setGame(null);
            setShowGuessForm(false);
            setNotice(message.payload?.message ?? "ホストがロビーに戻りました。");
            break;
          case "game:ended":
            lastExchangeIdRef.current = null;
            setHasQuestionUpdate(false);
            setGame(null);
            setShowGuessForm(false);
            setNotice(message.payload?.message ?? "ゲームが終了しました");
            break;
        }
      },
    });

    socketRef.current = client;
    client.connect();

    return () => {
      if (socketRef.current === client) socketRef.current = null;
      client.close();
    };
  }, []);

  // BGMは対戦中だけループ再生する。ブラウザが自動再生を拒否した場合は、
  // ゲーム内の再生ボタンを押すことでユーザー操作から再生できる。
  useEffect(() => {
    const audio = bgmRef.current;
    if (!audio) return;

    audio.loop = true;
    audio.volume = bgmVolume;

    if (game?.phase !== "playing" || !bgmEnabled) {
      audio.pause();
      if (game?.phase !== "playing") {
        try {
          audio.currentTime = 0;
        } catch {
          // メディアがまだ読み込まれていない場合はシークできないことがある。
        }
      }
      return;
    }

    if (bgmFileMissing) return;

    let cancelled = false;
    void audio.play().then(() => {
      if (cancelled) return;
      setBgmNeedsGesture(false);
    }).catch(() => {
      if (cancelled) return;
      if (audio.error) setBgmFileMissing(true);
      else setBgmNeedsGesture(true);
    });

    return () => {
      cancelled = true;
    };
  }, [game?.phase, bgmEnabled, bgmVolume, bgmFileMissing]);

  function handleToggleBgm() {
    const audio = bgmRef.current;
    if (!audio) return;

    if (bgmEnabled && !bgmNeedsGesture && !bgmFileMissing) {
      setBgmEnabled(false);
      audio.pause();
      return;
    }

    setBgmEnabled(true);
    if (game?.phase !== "playing") return;

    audio.volume = bgmVolume;
    void audio.play().then(() => {
      setBgmNeedsGesture(false);
      setBgmFileMissing(false);
    }).catch(() => {
      if (audio.error) setBgmFileMissing(true);
      else setBgmNeedsGesture(true);
    });
  }

  function sendMessage(message: ClientMessage) {
    const client = socketRef.current;
    if (!client || !client.send(message.type, message.payload)) {
      setNotice(connectionStatus === "reconnecting"
        ? "サーバーに再接続中です。接続が戻ってからもう一度操作してください。"
        : "サーバーに接続されていません");
      return;
    }
    setNotice("");
  }

  function handleCreateRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = playerName.trim();
    const length = Array.from(name).length;
    if (length < 1 || length > 12) {
      setNotice("プレイヤー名を1〜12文字で入力してください");
      return;
    }
    sendMessage({ type: "room:create", payload: { name } });
  }

  function handleJoinRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = playerName.trim();
    const code = roomCode.trim().toUpperCase();
    const length = Array.from(name).length;
    if (length < 1 || length > 12) {
      setNotice("プレイヤー名を1〜12文字で入力してください");
      return;
    }
    if (code.length !== 6) {
      setNotice("6文字のルームコードを入力してください");
      return;
    }
    sendMessage({ type: "room:join", payload: { name, roomCode: code } });
  }

  function handleToggleReady() {
    if (!lobby) return;
    const me = lobby.players.find((player) => player.id === playerId);
    sendMessage({ type: "room:ready", payload: { isReady: !(me?.isReady ?? false) } });
  }

  function handleMovePlayerOrder(index: number, direction: -1 | 1) {
    if (!lobby || lobby.players.length !== lobby.maxPlayers) return;
    if (lobby.players.find((player) => player.id === playerId)?.isHost !== true) return;

    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= lobby.players.length) return;

    const playerIds = lobby.players.map((player) => player.id);
    [playerIds[index], playerIds[nextIndex]] = [playerIds[nextIndex], playerIds[index]];
    sendMessage({ type: "room:set-order", payload: { playerIds } });
  }

  function handleStartGame() {
    sendMessage({ type: "game:start", payload: {} });
  }

  function handleLeaveRoom() {
    sendMessage({ type: "room:leave", payload: {} });
  }

  function handleReturnToLobby() {
    sendMessage({ type: "game:return-lobby", payload: {} });
  }

  function handleReturnHomeForEveryone() {
    sendMessage({ type: "game:return-home", payload: {} });
  }

  function handleAskQuestion(cardId: string, choiceNumber?: number) {
    sendMessage({ type: "game:ask-question", payload: { cardId, choiceNumber } });
  }

  function handleOpenGuessForm() {
    // 候補消去で残り5枚になっている場合は、その5枚を宣言フォームに確実に反映する。
    if (remainingMemoTiles.length === 5) setGuess(remainingMemoTiles);
    setShowGuessForm(true);
  }

  function handleGuess(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (guess.length !== 5) {
      setNotice("5枚すべて選択してください");
      return;
    }
    if (new Set(guess).size !== 5) {
      setNotice("同じタイルを重複して選択しないでください（黄5は2枚まで選択できます）");
      return;
    }
    const tiles = guess.map((value) => {
      const [color, number] = value.split(":");
      return { color: color as TileColor, number: Number(number) };
    });
    sendMessage({ type: "game:guess", payload: { tiles } });
    setShowGuessForm(false);
  }

  const canInteract = connectionStatus === "connected" && playerName.trim().length > 0;
  const me = lobby?.players.find((player) => player.id === playerId);
  const isHost = me?.isHost === true;
  const allReady = Boolean(
    lobby && lobby.players.length === lobby.maxPlayers && lobby.players.every((player) => player.isReady),
  );
  const isMyTurn = Boolean(game && game.phase === "playing" && game.currentPlayerId === playerId && game.ownStatus === "playing");
  const currentPlayerName = game?.players.find((player) => player.id === game.currentPlayerId)?.name;
  const activePlayers = useMemo(() => game?.players.filter((player) => player.status === "playing").length ?? 0, [game]);

  return (
    <div className={`${styles.page} ${game?.phase === "playing" ? styles.pageGame : ""}`}>
      <header className={styles.header}>
        <Link className={styles.brand} href="/">
          <span className={styles.brandMark}>T</span>
          <span><strong>TAGIRON</strong><small>ONLINE TABLE</small></span>
        </Link>
        <div className={styles.connection}>
          <span className={`${styles.statusDot} ${connectionStatus === "connected" ? styles.online : ""}`} />
          {connectionStatus === "connected"
            ? "サーバー接続中"
            : connectionStatus === "reconnecting"
              ? "再接続中..."
              : connectionStatus === "connecting"
                ? "接続中..."
                : "未接続"}
        </div>
      </header>

      <main className={`${styles.main} ${game?.phase === "playing" ? styles.mainGame : ""}`}>
        {game?.phase === "finished" ? (
          <section className={styles.gameScreen}>
            <div className={styles.resultHero}>
              <p className={styles.eyebrow}>GAME RESULT</p>
              <h1 className={styles.gameTitle}>推理の結果。</h1>
              <p className={styles.description}>順位と、中央に伏せられていた5枚のタイルを確認しましょう。</p>
            </div>

            <section className={styles.gameCard}>
              <p className={styles.sectionLabel}>FINAL RANKING</p>
              <h2>最終順位</h2>
              <ol className={styles.resultList}>
                {game.ranking.map((entry) => (
                  <li className={styles.resultItem} key={entry.playerId}>
                    <span className={`${styles.resultPlace} ${entry.place === 1 ? styles.firstPlace : ""}`}>{entry.place}</span>
                    <span className={styles.resultPlayerName}>
                      {entry.name}{entry.playerId === playerId ? <span className={styles.youBadge}>YOU</span> : null}
                    </span>
                    <span className={entry.result === "correct" ? styles.correctBadge : styles.incorrectBadge}>
                      {entry.result === "correct" ? "正解" : "不正解"}
                    </span>
                  </li>
                ))}
              </ol>
              <p className={styles.mutedNote}>正解した順に上位となり、不正解者は脱落が遅かった順に順位を決定します。</p>
            </section>

            <section className={styles.gameCard}>
              <p className={styles.sectionLabel}>REVEALED CENTER TILES</p>
              <h2>中央の伏せタイル</h2>
              <p className={styles.gameHelp}>ゲーム終了のため、答え合わせとして公開します。</p>
              <div className={styles.handTiles}>
                {(game.centerTiles ?? []).map((tile, index) => (
                  <div className={`${styles.numberTile} ${tileClass(tile.color)}`} key={`${tile.id}-${index}`}>
                    <span className={styles.tileIndex}>{index + 1}</span>
                    <strong>{tile.number}</strong>
                    <small>{colorName(tile.color)}</small>
                  </div>
                ))}
              </div>
            </section>

            <section className={styles.gameCard}>
              <p className={styles.sectionLabel}>ALL PLAYERS&apos; HANDS</p>
              <h2>全プレイヤーの手札</h2>
              <p className={styles.gameHelp}>
                ゲーム終了後の答え合わせです。各プレイヤーが持っていた5枚を公開しています。
              </p>
              <div className={styles.revealedHands}>
                {(game.revealedHands ?? []).map((hand) => {
                  const rankedPlayer = game.ranking.find(
                    (entry) => entry.playerId === hand.playerId,
                  );
                  return (
                    <section className={styles.revealedHand} key={hand.playerId}>
                      <div className={styles.revealedHandHeading}>
                        <h3>
                          {hand.playerName}
                          {hand.playerId === playerId ? (
                            <span className={styles.youBadge}>YOU</span>
                          ) : null}
                        </h3>
                        {rankedPlayer ? (
                          <span className={styles.revealedHandRank}>
                            {rankedPlayer.place}位 · {rankedPlayer.result === "correct" ? "正解" : "不正解"}
                          </span>
                        ) : null}
                      </div>
                      <div className={styles.handTiles}>
                        {hand.tiles.map((tile, index) => (
                          <div
                            className={`${styles.numberTile} ${tileClass(tile.color)}`}
                            key={`${tile.id}-${index}`}
                          >
                            <span className={styles.tileIndex}>{index + 1}</span>
                            <strong>{tile.number}</strong>
                            <small>{colorName(tile.color)}</small>
                          </div>
                        ))}
                      </div>
                    </section>
                  );
                })}
              </div>
              {(game.revealedHands ?? []).length === 0 ? (
                <p className={styles.mutedNote}>
                  全員の手札を取得できませんでした。サーバーが最新の更新版か確認してください。
                </p>
              ) : null}
            </section>


            {notice && <p className={styles.notice} role="status">{notice}</p>}

            <section className={styles.gameCard}>
              <p className={styles.sectionLabel}>NEXT STEP</p>
              {isHost ? (
                <>
                  <h2>次の行き先を選択</h2>
                  <p className={styles.gameHelp}>
                    ホストが選んだ行き先へ、全員が同時に移動します。
                  </p>
                  <div className={styles.resultActions}>
                    <button
                      className={styles.primaryButton}
                      type="button"
                      onClick={handleReturnToLobby}
                    >
                      全員でロビーへ戻る
                    </button>
                    <button
                      className={styles.secondaryButton}
                      type="button"
                      onClick={handleReturnHomeForEveryone}
                    >
                      全員でホームへ戻る
                    </button>
                  </div>
                </>
              ) : (
                <div className={styles.waitForHost} role="status" aria-live="polite">
                  <span className={styles.waitForHostDot} />
                  <div>
                    <h2>ホストを待っています</h2>
                    <p className={styles.gameHelp}>
                      ホストが「ロビーへ戻る」か「ホームへ戻る」を選ぶと、全員の画面が自動で切り替わります。
                    </p>
                  </div>
                </div>
              )}
            </section>
          </section>
        ) : game ? (
          <section className={styles.gameWorkspace}>
            <nav className={styles.mobileGameTabs} aria-label="ゲーム画面の切り替え">
              <button
                type="button"
                className={mobileGameTab === "game" ? styles.mobileGameTabActive : styles.mobileGameTab}
                aria-pressed={mobileGameTab === "game"}
                onClick={() => {
                  mobileGameTabRef.current = "game";
                  setMobileGameTab("game");
                  setHasQuestionUpdate(false);
                }}
              >
                <span aria-hidden="true">♟</span> ゲーム
                {hasQuestionUpdate && isMobileLayout && <span className={styles.mobileTabUpdate} aria-label="新しい質問があります">新着</span>}
              </button>
              <button
                type="button"
                className={mobileGameTab === "memo" ? styles.mobileGameTabActive : styles.mobileGameTab}
                aria-pressed={mobileGameTab === "memo"}
                onClick={() => {
                  mobileGameTabRef.current = "memo";
                  setMobileGameTab("memo");
                }}
              >
                <span aria-hidden="true">✎</span> 推理メモ
              </button>
            </nav>
            <div
              className={`${styles.gamePlayPanel} ${isMobileLayout && mobileGameTab === "memo" ? styles.mobilePanelHidden : ""}`}
              style={isMobileLayout && mobileGameTab === "memo" ? { display: "none" } : undefined}
            >

              <header className={styles.boardHeader}>
                <div className={styles.boardBrand}>
                  <span className={styles.boardMark}>T</span>
                  <span><strong>TAGIRON</strong><small>DEDUCTION TABLE</small></span>
                </div>
                <div className={styles.boardHeaderMeta}>
                  <span className={styles.turnPill}>TURN {String(game.turnNumber).padStart(2, "0")}</span>
                  <span className={styles.roomPill}>ROOM {game.roomCode}</span>
                  <div className={styles.bgmControls} aria-label="BGM設定">
                    <button
                      className={`${styles.bgmToggle} ${bgmFileMissing ? styles.bgmUnavailable : ""}`}
                      type="button"
                      onClick={handleToggleBgm}
                      aria-pressed={bgmEnabled && !bgmNeedsGesture && !bgmFileMissing}
                      aria-label={bgmFileMissing ? "BGMファイルがありません。public/audio/bgm.mp3 に音源を配置してください" : bgmNeedsGesture ? "BGMを再生" : bgmEnabled ? "BGMを停止" : "BGMを再生"}
                      title={bgmFileMissing ? "public/audio/bgm.mp3 に音源を配置してください" : bgmNeedsGesture ? "クリックしてBGMを再生" : bgmEnabled ? "BGMを停止" : "BGMを再生"}
                    >
                      {bgmEnabled && !bgmNeedsGesture && !bgmFileMissing ? "Ⅱ" : "▶"}
                    </button>
                    <label className={styles.bgmVolumeControl} title={`BGM音量 ${Math.round(bgmVolume * 100)}%`}>
                      <span>♪</span>
                      <input
                        aria-label="BGM音量"
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        value={bgmVolume}
                        onChange={(event) => setBgmVolume(Number(event.target.value))}
                      />
                    </label>
                  </div>
                  <button className={styles.boardExit} type="button" onClick={handleLeaveRoom}>退出</button>
                </div>
              </header>

              <div className={`${styles.compactTurnBanner} ${isMyTurn ? styles.compactMyTurn : ""}`}>
                <div className={styles.turnPulse} />
                <div className={styles.compactTurnCopy}>
                  <strong>{game.ownStatus !== "playing" ? playerStatusLabel(game.ownStatus) : isMyTurn ? "あなたの手番です" : `${currentPlayerName ?? "プレイヤー"} の手番`}</strong>
                  <span>{game.ownStatus === "playing" ? (isMyTurn ? "質問を選ぶか、伏せタイルの並びを宣言" : "次の手番を待ちながら、メモで推理しよう") : "観戦中 — 推理メモは引き続き使えます"}</span>
                </div>
                <span className={styles.activeCountCompact}>{activePlayers} / 3 ACTIVE</span>
              </div>

              <section className={styles.tableTilesRow}>
                <div className={styles.handTablePanel}>
                  <div className={styles.tableSectionTitle}><span>YOUR HAND</span><strong>あなたの数字タイル</strong></div>
                  <div className={styles.compactHandTiles}>
                    {game.ownTiles.map((tile, index) => (
                      <div key={tile.id} className={`${styles.compactNumberTile} ${tileClass(tile.color)}`}>
                        <span>{index + 1}</span><strong>{tile.number}</strong>
                      </div>
                    ))}
                  </div>
                </div>
                <div className={styles.centerTablePanel}>
                  <div className={styles.tableSectionTitle}><span>HIDDEN CODE</span><strong>中央の伏せタイル</strong></div>
                  <div className={styles.compactHiddenTiles}>
                    {Array.from({ length: game.centerTileCount }, (_, index) => (
                      <div className={styles.compactHiddenTile} key={index}><span>?</span></div>
                    ))}
                  </div>
                </div>
              </section>

              <section className={styles.playersRail} aria-label="参加プレイヤー">
                {game.players.map((player, index) => (
                  <div className={`${styles.playerRailItem} ${player.id === game.currentPlayerId ? styles.playerRailActive : ""}`} key={player.id}>
                    <span className={styles.playerRailIndex}>0{index + 1}</span>
                    <span className={styles.playerRailAvatar}>{Array.from(player.name)[0] ?? "?"}</span>
                    <span className={styles.playerRailText}><strong>{player.name}{player.id === playerId ? "（あなた）" : ""}</strong><small>{player.id === game.currentPlayerId ? "手番" : playerStatusLabel(player.status)}</small></span>
                    {player.isHost && <span className={styles.hostMini}>HOST</span>}
                  </div>
                ))}
              </section>

              <section className={styles.exchangePanel} aria-live="polite">
                {game.lastExchange ? (
                  <QuestionReveal key={game.lastExchange.id} exchange={game.lastExchange} playerId={playerId} />
                ) : (
                  <div className={styles.exchangeWaiting}>
                    <span className={styles.exchangeWaitingIcon}>✦</span>
                    <div><strong>最初の質問を待っています</strong><small>質問カードが選ばれると、回答が順番に公開されます。</small></div>
                  </div>
                )}
              </section>

              <section className={styles.questionDock}>
                <div className={styles.questionDockHeader}>
                  <div><span className={styles.questionDockEyebrow}>CHOOSE YOUR CLUE</span><strong>質問カード</strong></div>
                  <span className={styles.questionRemaining}>{game.questionCards.length} CARDS LEFT</span>
                </div>
                {game.ownStatus === "playing" && game.questionCards.length > 0 ? (
                  <div className={styles.compactQuestionGrid}>
                    {game.questionCards.map((card, index) => (
                      <div className={`${styles.compactQuestionCard} ${card.shared ? styles.compactSharedCard : ""}`} key={card.id}>
                        <div className={styles.compactQuestionTop}><span>Q{String(index + 1).padStart(2, "0")}</span>{card.shared && <small>ALL</small>}</div>
                        <strong>{card.text}</strong>
                        <div className={styles.compactQuestionActions}>
                          {card.choices ? card.choices.map((choice) => (
                            <button className={styles.compactAskButton} key={choice} type="button" disabled={!isMyTurn} onClick={() => handleAskQuestion(card.id, choice)}>{choice}で質問</button>
                          )) : (
                            <button className={styles.compactAskButton} type="button" disabled={!isMyTurn} onClick={() => handleAskQuestion(card.id)}>質問する <span>→</span></button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : game.ownStatus !== "playing" ? (
                  <div className={styles.spectatorMessage}>あなたは今回の推理を終了しました。ほかのプレイヤーの対戦を見守りましょう。</div>
                ) : (
                  <div className={styles.spectatorMessage}>質問カードはすべて使用されました。手番で中央タイルの並びを宣言できます。</div>
                )}
              </section>

              <div className={styles.boardBottomBar}>
                {notice ? <span className={styles.boardNotice} role="status">{notice}</span> : <span className={styles.boardHint}>推理メモはこの端末だけに保存されます</span>}
                <button className={styles.guessActionButton} type="button" disabled={!isMyTurn} onClick={handleOpenGuessForm}>中央の並びを宣言 <span>↗</span></button>
              </div>
            </div>

            <MemoPanel
              roomCode={game.roomCode}
              playerId={playerId}
              players={game.players}
              onRemainingTilesChange={handleRemainingTilesChange}
              className={isMobileLayout && mobileGameTab === "game" ? styles.mobilePanelHidden : ""}
              isHidden={isMobileLayout && mobileGameTab === "game"}
            />

            {showGuessForm && (
              <div className={styles.guessModalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowGuessForm(false); }}>
                <section className={styles.guessModal} role="dialog" aria-modal="true" aria-labelledby="guessModalTitle">
                  <button className={styles.modalClose} type="button" onClick={() => setShowGuessForm(false)} aria-label="閉じる">×</button>
                  <p className={styles.questionDockEyebrow}>FINAL DEDUCTION</p>
                  <h2 id="guessModalTitle">中央タイルの並びを宣言</h2>
                  <p className={styles.gameHelp}>中央の5枚を左から順番に選びます。宣言できるのは1人1回だけです。</p>
                  <form onSubmit={handleGuess}>
                    <div className={styles.guessGrid}>
                      {guess.map((value, index) => (
                        <label className={styles.guessField} key={index}>
                          <span>左から{index + 1}枚目</span>
                          <select value={value} onChange={(event) => setGuess((old) => old.map((item, itemIndex) => itemIndex === index ? event.target.value : item))}>
                            {guessOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
                          </select>
                        </label>
                      ))}
                    </div>
                    <p className={styles.mutedNote}>同じ赤・青タイルは重複できません。黄色の5は2枚まで選択できます。</p>
                    <div className={styles.guessActions}>
                      <button className={styles.secondaryButton} type="button" onClick={() => setShowGuessForm(false)}>キャンセル</button>
                      <button className={styles.primaryButton} type="submit" disabled={!isMyTurn}>この並びで宣言する</button>
                    </div>
                  </form>
                </section>
              </div>
            )}
          </section>
        ) : !lobby ? (
          <>
            <section className={styles.hero}>
              <p className={styles.eyebrow}>THREE PLAYERS · DEDUCTION GAME</p>
              <h1 className={styles.title}>ヒントから、<br /><span>数字を読み解く。</span></h1>
              <p className={styles.description}>質問と推理で、相手の数字を見破ろう。<br />ルームを作成して、友達と対戦しよう。</p>
              <div className={styles.tileRow} aria-hidden="true">
                <div className={`${styles.tile} ${styles.tileBlue}`}><span>2</span><small>BLUE</small></div>
                <div className={`${styles.tile} ${styles.tileYellow}`}><span>5</span><small>YELLOW</small></div>
                <div className={`${styles.tile} ${styles.tileRed}`}><span>8</span><small>RED</small></div>
              </div>
              <p className={styles.heroNote}>3人対戦 / ルームコードで合流 / リアルタイム同期</p>
            </section>
            <section className={styles.panelStack}>
              <section className={styles.card}>
                <p className={styles.sectionLabel}>YOUR PROFILE</p>
                <label className={styles.label} htmlFor="playerName">プレイヤー名</label>
                <input id="playerName" className={styles.input} type="text" value={playerName} onChange={(event) => setPlayerName(event.target.value)} placeholder="名前を入力（12文字まで）" maxLength={12} autoComplete="nickname" />
              </section>
              <section className={styles.card}>
                <div className={styles.cardHeading}><span className={styles.number}>01</span><div><h2>ルームを作成</h2><p>あなたがホストになって対戦を始める</p></div></div>
                <form onSubmit={handleCreateRoom}><button className={styles.primaryButton} type="submit" disabled={!canInteract}>ルームを作成する <span aria-hidden="true">→</span></button></form>
              </section>
              <section className={styles.card}>
                <div className={styles.cardHeading}><span className={styles.number}>02</span><div><h2>ルームに参加</h2><p>招待されたコードを入力する</p></div></div>
                <form onSubmit={handleJoinRoom}>
                  <label className={styles.label} htmlFor="roomCode">ルームコード</label>
                  <input id="roomCode" className={`${styles.input} ${styles.codeInput}`} type="text" value={roomCode} onChange={(event) => setRoomCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))} placeholder="例：AB3XYZ" maxLength={6} autoCapitalize="characters" autoComplete="off" />
                  <button className={styles.secondaryButton} type="submit" disabled={!canInteract || roomCode.length !== 6}>参加する</button>
                </form>
              </section>
              {notice && <p className={styles.notice} role="status">{notice}</p>}
            </section>
          </>
        ) : (
          <section className={styles.lobbyScreen}>
            <div className={styles.lobbyIntro}>
              <p className={styles.eyebrow}>WAITING ROOM</p><h1 className={styles.gameTitle}>対戦の準備をしよう。</h1>
              <p className={styles.description}>3人そろったら、ホストが手番の順番を決めます。その後、それぞれ準備完了を押すとゲームを開始できます。</p>
            </div>
            <section className={styles.card}>
              <div className={styles.cardHeading}><span className={styles.number}>01</span><div><h2>ルームコード</h2><p>一緒に遊ぶ人に共有してください</p></div></div>
              <div className={styles.codeBox}><span>ROOM CODE</span><strong>{lobby.roomCode}</strong></div>
              <div className={styles.playerCount}><strong>{lobby.players.length} / {lobby.maxPlayers}</strong><span>人が参加中</span></div>
              <ul className={styles.playerList}>
                {Array.from({ length: lobby.maxPlayers }, (_, index) => {
                  const player = lobby.players[index];
                  return <li className={styles.playerItem} key={player?.id ?? `empty-${index}`}>
                    <span className={styles.playerNumber}>{String(index + 1).padStart(2, "0")}</span>
                    {player ? <>
                      <span className={styles.playerName}>{player.name}{player.isHost && <span className={styles.hostBadge}>HOST</span>}{player.id === playerId && <span className={styles.youBadge}>YOU</span>}</span>
                      <span className={player.isReady ? styles.readyBadge : styles.notReadyBadge}>{player.isReady ? "準備完了" : "準備中"}</span>
                      {lobby.players.length === lobby.maxPlayers && isHost && <div className={styles.orderControls} aria-label={`${player.name}の手番順を変更`}>
                        <button className={styles.orderButton} type="button" disabled={index === 0} onClick={() => handleMovePlayerOrder(index, -1)} aria-label={`${player.name}を1つ前へ`}>↑</button>
                        <button className={styles.orderButton} type="button" disabled={index === lobby.players.length - 1} onClick={() => handleMovePlayerOrder(index, 1)} aria-label={`${player.name}を1つ後ろへ`}>↓</button>
                      </div>}
                    </> : <span className={styles.emptyPlayer}>参加者を待っています…</span>}
                  </li>;
                })}
              </ul>
              {lobby.players.length === lobby.maxPlayers && <p className={styles.orderHint}>{isHost ? "上下ボタンで手番順を変更できます。上から順に手番が回ります。" : "手番順はホストが設定します。表示順が手番順です。"}</p>}
              <div className={styles.readyPanel}>
                <p className={styles.readyHint}>{lobby.players.length < lobby.maxPlayers ? "あとプレイヤーがそろうまで待ちましょう。" : allReady ? "全員の準備が完了しました。" : "自分の準備ができたらボタンを押してください。"}</p>
                <button className={me?.isReady ? styles.secondaryButton : styles.primaryButton} type="button" disabled={!me || lobby.phase !== "lobby"} onClick={handleToggleReady}>{me?.isReady ? "準備完了を取り消す" : "準備完了"}</button>
                {isHost ? <button className={styles.startButton} type="button" disabled={lobby.players.length !== lobby.maxPlayers || !allReady} onClick={handleStartGame}>ゲーム開始 <span aria-hidden="true">→</span></button> : <p className={styles.hostWait}>{allReady ? "ホストがゲームを開始するのを待っています。" : "全員の準備完了後、ホストが開始します。"}</p>}
              </div>
              {notice && <p className={styles.notice} role="status">{notice}</p>}
              <button className={styles.textButton} type="button" onClick={handleLeaveRoom}>ルームから退出する</button>
            </section>
          </section>
        )}
      </main>
      <audio
        ref={bgmRef}
        src="/audio/bgm.mp3"
        loop
        preload="none"
        onError={() => setBgmFileMissing(true)}
      />
      <footer className={styles.footer}>TAGIRON · LOCAL NETWORK PLAY</footer>
    </div>
  );
}



type MemoTileChoice = { key: string; number: number; color: TileColor; label: string };
const memoTileChoices: MemoTileChoice[] = [
  ...Array.from({ length: 5 }, (_, number) => [
    { key: `red:${number}`, number, color: "red" as const, label: `赤${number}` },
    { key: `blue:${number}`, number, color: "blue" as const, label: `青${number}` },
  ]).flat(),
  { key: "yellow:5", number: 5, color: "yellow", label: "黄5 ×2" },
  ...Array.from({ length: 4 }, (_, index) => index + 6).flatMap((number) => [
    { key: `red:${number}`, number, color: "red" as const, label: `赤${number}` },
    { key: `blue:${number}`, number, color: "blue" as const, label: `青${number}` },
  ]),
];

// 5のタイルは黄色が2枚あるため、赤・青の列の「5」の位置に1枚ずつ表示する。
// 表示上のキーは分け、候補消去で黄色の5を1枚ずつ区別できるようにする。
const memoCandidateRows = ([
  { color: "red" as const, label: "赤" },
  { color: "blue" as const, label: "青" },
]).map((row) => ({
  ...row,
  tiles: Array.from({ length: 10 }, (_, number) =>
    number === 5
      ? { key: `yellow:5:${row.color}`, number: 5, color: "yellow" as const, label: "黄5" }
      : memoTileChoices.find((tile) => tile.color === row.color && tile.number === number) ?? null,
  ),
}));

type MemoStats = {
  redCount: string;
  redSum: string;
  blueCount: string;
  blueSum: string;
  evenCount: string;
  oddCount: string;
  pairs: string;
  totalSum: string;
};
type MemoPlayerCondition = {
  stats: MemoStats;
  frontThreeSum: string;
  centerThreeSum: string;
  backThreeSum: string;
};
type MemoData = {
  crossedOut: string[];
  sequences: Record<string, string[]>;
  conditions: Record<string, MemoPlayerCondition>;
  notes: Record<string, string>;
};

const emptyMemoStats: MemoStats = {
  redCount: "", redSum: "", blueCount: "", blueSum: "",
  evenCount: "", oddCount: "", pairs: "", totalSum: "",
};

function emptyPlayerCondition(): MemoPlayerCondition {
  return {
    stats: { ...emptyMemoStats },
    frontThreeSum: "",
    centerThreeSum: "",
    backThreeSum: "",
  };
}

function createEmptyConditions(players: PlayerSummary[], playerId: string): Record<string, MemoPlayerCondition> {
  return Object.fromEntries(
    players.filter((player) => player.id !== playerId).slice(0, 2)
      .map((player) => [player.id, emptyPlayerCondition()]),
  );
}

function createEmptyNotes(players: PlayerSummary[], playerId: string): Record<string, string> {
  return Object.fromEntries(
    players.filter((player) => player.id !== playerId).slice(0, 2)
      .map((player) => [player.id, ""]),
  );
}

const emptyMemoData: MemoData = {
  crossedOut: [],
  sequences: {},
  conditions: {},
  notes: {},
};

function QuestionReveal({ exchange, playerId }: { exchange: QuestionExchange; playerId: string }) {
  const isMyQuestion = exchange.actorId === playerId;
  return (
    <div className={styles.exchangeContent}>
      <div className={styles.exchangeQuestionCard}>
        <div className={styles.exchangeQuestionMeta}><span>QUESTION REVEALED</span><span>TURN {String(exchange.turn).padStart(2, "0")}</span></div>
        <div className={styles.exchangeQuestionText}><span className={styles.exchangeGem}>✦</span><strong>{exchange.text}</strong></div>
        <div className={styles.exchangeQuestionFooter}><span>{exchange.actorName}{isMyQuestion ? "（あなた）" : ""} の質問</span><span>{exchange.shared ? "全員が回答" : "ほかの2人が回答"}</span></div>
      </div>
      <div className={styles.exchangeAnswers}>
        {exchange.responses.map((response, index) => (
          <div className={styles.exchangeAnswer} key={response.playerId}>
            <span className={styles.answerOrder}>{String(index + 1).padStart(2, "0")}</span>
            <span className={styles.answerPlayer}>{response.playerName}{response.playerId === playerId ? "（あなた）" : ""}</span>
            <strong>{response.answer}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function MemoPanel({
  roomCode,
  playerId,
  players,
  onRemainingTilesChange,
  className,
  isHidden = false,
}: {
  roomCode: string;
  playerId: string;
  players: PlayerSummary[];
  onRemainingTilesChange: (tiles: string[]) => void;
  className?: string;
  isHidden?: boolean;
}) {
  const storageKey = `tagiron-private-memo-v3:${roomCode}:${playerId}`;
  const opponents = players.filter((player) => player.id !== playerId).slice(0, 2);
  const [memo, setMemo] = useState<MemoData>(emptyMemoData);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let loadedMemo: MemoData = {
      ...emptyMemoData,
      conditions: createEmptyConditions(players, playerId),
      notes: createEmptyNotes(players, playerId),
    };
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved) {
        const parsed = JSON.parse(saved) as Partial<MemoData> & { note?: unknown };
        const savedConditions: Record<string, Partial<MemoPlayerCondition> | undefined> =
          parsed.conditions && typeof parsed.conditions === "object"
            ? parsed.conditions
            : {};
        const conditions = Object.fromEntries(opponents.map((player) => {
          const raw = savedConditions[player.id] as Partial<MemoPlayerCondition> | undefined;
          return [player.id, {
            ...emptyPlayerCondition(),
            ...raw,
            stats: { ...emptyMemoStats, ...(raw?.stats ?? {}) },
            frontThreeSum: typeof raw?.frontThreeSum === "string" ? raw.frontThreeSum : "",
            centerThreeSum: typeof raw?.centerThreeSum === "string" ? raw.centerThreeSum : "",
            backThreeSum: typeof raw?.backThreeSum === "string" ? raw.backThreeSum : "",
          } satisfies MemoPlayerCondition];
        }));
        const savedNotes = parsed.notes && typeof parsed.notes === "object"
          ? parsed.notes as Record<string, unknown>
          : {};
        const legacyNote = typeof parsed.note === "string" ? parsed.note : "";
        const notes = Object.fromEntries(opponents.map((player, index) => [
          player.id,
          typeof savedNotes[player.id] === "string"
            ? savedNotes[player.id] as string
            : index === 0 ? legacyNote : "",
        ]));
        const crossedOut = Array.isArray(parsed.crossedOut) ? [...parsed.crossedOut] : [];
        // Older memos represented the two yellow 5s as one "×2" tile. Preserve that mark
        // by crossing out both newly separated visual candidates.
        if (crossedOut.includes("yellow:5")) {
          const oldIndex = crossedOut.indexOf("yellow:5");
          crossedOut.splice(oldIndex, 1);
          crossedOut.push("yellow:5:red", "yellow:5:blue");
        }
        loadedMemo = {
          crossedOut,
          sequences: parsed.sequences && typeof parsed.sequences === "object" ? parsed.sequences : {},
          conditions,
          notes,
        };
      }
    } catch {
      loadedMemo = {
        ...emptyMemoData,
        conditions: createEmptyConditions(players, playerId),
        notes: createEmptyNotes(players, playerId),
      };
    }
    // Only the two opponents need a hand-order prediction row; your own hand is visible above.
    delete loadedMemo.sequences[playerId];
    // This is a one-time localStorage hydration; setting the initial memo here is intentional.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMemo(loadedMemo);
    setLoaded(true);
    // Initial read is intentionally once per room/player key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  useEffect(() => {
    if (!loaded) return;
    const availableTiles = memoCandidateRows.flatMap((row) => row.tiles.flatMap((tile) => {
      if (!tile || memo.crossedOut.includes(tile.key)) return [];
      if (tile.color === "yellow") {
        return [{ key: tile.key.endsWith(":red") ? "yellow:5:a" : "yellow:5:b", number: tile.number }];
      }
      return [{ key: `${tile.color}:${tile.number}`, number: tile.number }];
    }))
      // 数字の昇順。数字が同じ場合は赤→青→黄の順にし、文字列順で青が先にならないようにする。
      .sort((a, b) => {
        const colorPriority = (key: string) =>
          key.startsWith("red:") ? 0 : key.startsWith("blue:") ? 1 : 2;
        return a.number - b.number || colorPriority(a.key) - colorPriority(b.key) || a.key.localeCompare(b.key);
      })
      .map((tile) => tile.key);
    onRemainingTilesChange(availableTiles);
  }, [memo.crossedOut, loaded, onRemainingTilesChange]);

  useEffect(() => {
    if (!loaded) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(memo));
    } catch {
      // Storage can be disabled; the memo still works for this page session.
    }
  }, [memo, loaded, storageKey]);

  function toggleCrossedOut(key: string) {
    setMemo((old) => ({
      ...old,
      crossedOut: old.crossedOut.includes(key)
        ? old.crossedOut.filter((item) => item !== key)
        : [...old.crossedOut, key],
    }));
  }

  function setSequence(player: PlayerSummary, index: number, value: string) {
    setMemo((old) => {
      const row = [...(old.sequences[player.id] ?? ["", "", "", "", ""])];
      while (row.length < 5) row.push("");
      row[index] = value;
      return { ...old, sequences: { ...old.sequences, [player.id]: row } };
    });
  }

  function setPlayerStat(targetPlayerId: string, key: keyof MemoStats, value: string) {
    setMemo((old) => {
      const current = old.conditions[targetPlayerId] ?? emptyPlayerCondition();
      return {
        ...old,
        conditions: {
          ...old.conditions,
          [targetPlayerId]: {
            ...current,
            stats: { ...current.stats, [key]: value },
          },
        },
      };
    });
  }

  function setPlayerSum(
    targetPlayerId: string,
    key: "frontThreeSum" | "centerThreeSum" | "backThreeSum",
    value: string,
  ) {
    setMemo((old) => {
      const current = old.conditions[targetPlayerId] ?? emptyPlayerCondition();
      return {
        ...old,
        conditions: {
          ...old.conditions,
          [targetPlayerId]: { ...current, [key]: value },
        },
      };
    });
  }

  function clearMemo() {
    setMemo({
      ...emptyMemoData,
      conditions: createEmptyConditions(players, playerId),
      notes: createEmptyNotes(players, playerId),
    });
  }

  return (
    <aside
      className={`${styles.memoPanel} ${className ?? ""}`}
      style={isHidden ? { display: "none" } : undefined}
      aria-label="個人用推理メモ"
    >
      <header className={styles.memoHeader}>
        <div className={styles.memoBrand}><span className={styles.memoLogo}>M</span><span><strong>DEDUCTION MEMO</strong><small>PRIVATE NOTE · THIS DEVICE</small></span></div>
        <button className={styles.memoClear} type="button" onClick={clearMemo}>リセット</button>
      </header>

      <div className={styles.memoTitleRow}>
        <div><p>TAGIRON / 3 PLAYERS</p><h2>推理メモ</h2></div>
        <span className={styles.memoSaveState}><i /> 自動保存</span>
      </div>

      <div className={styles.memoBody}>
        <section className={styles.memoSection}>
          <div className={styles.memoSectionHeading}><strong>候補タイルを消去</strong><span>色ごとに数字を整列 · タップで × / 復帰</span></div>
          <div className={styles.memoTileGrid}>
            {memoCandidateRows.map((row) => (
              <div className={styles.memoCandidateRow} key={row.color}>
                <span className={`${styles.memoColorLabel} ${tileClass(row.color)}`}>{row.label}</span>
                {row.tiles.map((tile, number) => {
                  if (!tile) return <span className={styles.memoTileSpacer} key={`${row.color}-${number}`} aria-hidden="true" />;
                  const crossed = memo.crossedOut.includes(tile.key);
                  return (
                    <button key={tile.key} type="button" aria-pressed={crossed} onClick={() => toggleCrossedOut(tile.key)} className={`${styles.memoTile} ${tileClass(tile.color)} ${crossed ? styles.memoTileCrossed : ""}`} title={`${tile.label} 候補を${crossed ? "復帰" : "消去"}`}>
                      <strong>{tile.number}</strong><small>{tile.color === "red" ? "R" : tile.color === "blue" ? "B" : "Y"}</small>{crossed && <span className={styles.crossMark}>×</span>}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </section>

        <section className={styles.memoSection}>
          <div className={styles.memoSectionHeading}><strong>相手2人の5枚の並び予想</strong><span>左から小さい順</span></div>
          <div className={styles.memoHandRows}>
            {opponents.map((player, playerIndex) => (
              <div className={styles.memoHandRow} key={player.id}>
                <div className={styles.memoHandLabel}><span>{playerIndex + 1}</span><strong>{player.name}</strong></div>
                <div className={styles.memoSlots}>
                  {Array.from({ length: 5 }, (_, index) => {
                    const selected = memo.sequences[player.id]?.[index] ?? "";
                    const [savedColor, savedNumber = ""] = selected.split(":");
                    const selectedColor = (["red", "blue", "yellow", "white"] as const).includes(savedColor as "red" | "blue" | "yellow" | "white")
                      ? savedColor as "red" | "blue" | "yellow" | "white"
                      : "white";
                    const colorClass = selectedColor === "white" ? styles.memoSlotWhite : tileClass(selectedColor);
                    const colorOrder = ["red", "blue", "yellow", "white"] as const;
                    const nextColor = colorOrder[(colorOrder.indexOf(selectedColor) + 1) % colorOrder.length];
                    return (
                      <div
                        className={`${styles.memoSlot} ${styles.memoSlotTile} ${colorClass}`}
                        key={index}
                        onClick={() => setSequence(player, index, `${nextColor}:${savedNumber}`)}
                        title="タイルの数字以外の部分をタップして色を変更"
                      >
                        <small>{index + 1}</small>
                        <input
                          type="number"
                          inputMode="numeric"
                          min={0}
                          max={9}
                          step={1}
                          aria-label={`${player.name} 左から${index + 1}枚目の数字`}
                          value={savedNumber}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => setSequence(player, index, `${selectedColor}:${event.target.value}`)}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className={`${styles.memoSection} ${styles.memoConditionsSection}`}>
          <div className={styles.memoSectionHeading}><strong>質問で判明した条件</strong><span>相手ごとに記録</span></div>
          <div className={styles.memoConditionPlayers}>
            {opponents.map((player, playerIndex) => {
              const condition = memo.conditions[player.id] ?? emptyPlayerCondition();
              return (
                <section className={styles.memoConditionCard} key={player.id}>
                  <div className={styles.memoConditionPlayerTitle}><span>{String(playerIndex + 1).padStart(2, "0")}</span><strong>{player.name}</strong></div>
                  <div className={styles.memoStatsGrid}>
                    {(([
                      ["redCount", "赤の枚数"], ["redSum", "赤の合計"],
                      ["blueCount", "青の枚数"], ["blueSum", "青の合計"],
                      ["evenCount", "偶数枚数"], ["oddCount", "奇数枚数"],
                      ["pairs", "同数ペア"], ["totalSum", "全体合計"],
                    ] as [keyof MemoStats, string][])).map(([key, label]) => (
                      <label className={styles.memoStatField} key={key}>
                        <span>{label}</span>
                        <input inputMode="numeric" value={condition.stats[key]} onChange={(event) => setPlayerStat(player.id, key, event.target.value)} aria-label={`${player.name} ${label}`} />
                      </label>
                    ))}
                  </div>
                  <div className={styles.memoSumsGrid}>
                    {([
                      ["frontThreeSum", "前3枚"],
                      ["centerThreeSum", "中央3枚"],
                      ["backThreeSum", "後3枚"],
                    ] as ["frontThreeSum" | "centerThreeSum" | "backThreeSum", string][]).map(([key, label]) => (
                      <label className={styles.memoSumField} key={key}>
                        <span>{label}合計</span>
                        <input inputMode="numeric" value={condition[key]} onChange={(event) => setPlayerSum(player.id, key, event.target.value)} aria-label={`${player.name} ${label}の合計`} />
                      </label>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
          <div className={styles.memoNotesGrid} aria-label="プレイヤー別の自由メモ">
            {opponents.map((player, index) => (
              <label className={styles.memoNoteField} key={player.id}>
                <span>自由メモ · {player.name || `相手 ${index + 1}`}</span>
                <textarea
                  value={memo.notes[player.id] ?? ""}
                  onChange={(event) => setMemo((old) => ({
                    ...old,
                    notes: { ...old.notes, [player.id]: event.target.value },
                  }))}
                  placeholder={`${player.name}についての推理や質問で分かったこと…`}
                  rows={3}
                />
              </label>
            ))}
          </div>
          <p className={styles.memoFootnote}>このメモはこのブラウザだけに保存され、相手には共有されません。</p>
        </section>
      </div>

      <footer className={styles.memoFooter}><span>ROOM {roomCode}</span><span>NOTES ARE LOCAL ONLY</span></footer>
    </aside>
  );
}
