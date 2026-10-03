import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const hashPassword = promisify(scrypt);
const tokenHash = (token) => createHash("sha256").update(token).digest("hex");

export function createAccounts(database, secureCookies = false) {
  const attempts = new Map();
  const historyWrites = new Map();
  const publicUser = (row) => ({ id: row.id, username: row.username, name: row.display_name });

  function cookieToken(request) {
    return /(?:^|;\s*)watch_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie || "")?.[1] || "";
  }
  function cookie(token, maxAge = 2592000) {
    return `watch_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`;
  }
  async function session(user) {
    const token = randomBytes(32).toString("hex");
    await database.pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 days')", [tokenHash(token), user.id]);
    return { user: publicUser(user), cookie: cookie(token) };
  }
  function checkAttempt(request) {
    const address = request.socket.remoteAddress || "unknown";
    const now = Date.now();
    const attempt = attempts.get(address);
    if (attempt && attempt.expiresAt > now) {
      if (attempt.count >= 30) throw Object.assign(new Error("尝试过于频繁，请稍后再试"), { status: 429 });
      attempt.count += 1;
    } else attempts.set(address, { count: 1, expiresAt: now + 600000 });
    if (attempts.size > 1000) for (const [key, value] of attempts) if (value.expiresAt < now) attempts.delete(key);
  }
  function credentials(input) {
    const username = String(input.username || "").normalize("NFKC").trim().toLowerCase();
    const password = String(input.password || "");
    if (!/^[\p{L}\p{N}_-]{2,24}$/u.test(username) || password.length < 8 || password.length > 128) {
      throw Object.assign(new Error("用户名需 2–24 位，密码需 8–128 位"), { status: 400 });
    }
    return { username, password };
  }
  async function register(request, input) {
    checkAttempt(request);
    const { username, password } = credentials(input);
    const salt = randomBytes(16).toString("hex");
    const hash = (await hashPassword(password, salt, 64)).toString("hex");
    try {
      const result = await database.pool.query("INSERT INTO users(id,username,display_name,password_hash,salt) VALUES($1,$2,$3,$4,$5) RETURNING *", [randomUUID(), username, String(input.name || username).trim().slice(0, 24) || username, hash, salt]);
      return session(result.rows[0]);
    } catch (error) {
      if (error.code === "23505") throw Object.assign(new Error("这个用户名已被使用"), { status: 409 });
      throw error;
    }
  }
  async function login(request, input) {
    checkAttempt(request);
    const { username, password } = credentials(input);
    const result = await database.pool.query("SELECT * FROM users WHERE username=$1", [username]);
    const row = result.rows[0];
    const hash = await hashPassword(password, row?.salt || "invalid-account-salt", 64);
    if (!row || !timingSafeEqual(hash, Buffer.from(row.password_hash, "hex"))) throw Object.assign(new Error("用户名或密码不正确"), { status: 401 });
    return session(row);
  }
  async function getUser(request) {
    const token = cookieToken(request);
    if (!token) return null;
    const result = await database.pool.query("SELECT u.id,u.username,u.display_name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()", [tokenHash(token)]);
    return result.rows[0] ? publicUser(result.rows[0]) : null;
  }
  async function logout(request) {
    const token = cookieToken(request);
    if (token) await database.pool.query("DELETE FROM sessions WHERE token_hash=$1", [tokenHash(token)]);
    return cookie("", 0);
  }
  function queueHistory(userId, write) {
    const operation = (historyWrites.get(userId) || Promise.resolve()).then(write);
    const settled = operation.catch(() => {});
    historyWrites.set(userId, settled);
    settled.finally(() => { if (historyWrites.get(userId) === settled) historyWrites.delete(userId); });
    return operation;
  }
  function recordHistory(userId, media, position = 0, duration = 0) {
    if (!media.url) return;
    const key = media.contentKey || media.collectionId || media.resourceId || tokenHash(media.title || media.url);
    return queueHistory(userId, () => database.pool.query(`INSERT INTO watch_history(user_id,content_key,media,position,duration) VALUES($1,$2,$3::jsonb,$4,$5)
      ON CONFLICT(user_id,content_key) DO UPDATE SET media=EXCLUDED.media,position=EXCLUDED.position,duration=EXCLUDED.duration,updated_at=now()`,
      [userId, key, JSON.stringify(media), Math.max(0, Math.min(604800, Number(position) || 0)), Math.max(0, Math.min(604800, Number(duration) || 0))]));
  }
  async function history(userId, isAvailable = () => true) {
    await historyWrites.get(userId);
    const result = await database.pool.query("SELECT content_key,media,position,duration,updated_at FROM watch_history WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 100", [userId]);
    return result.rows.map((row) => ({ key: row.content_key, title: row.media.title, poster: row.media.poster,
      episodeTitle: row.media.episodeTitle, playlistIndex: row.media.playlistIndex,
      playlistLength: row.media.playlistLength || 0, completed: row.duration > 0 && row.position >= row.duration - 1,
      available: isAvailable(row.media),
      position: row.position, duration: row.duration, updatedAt: row.updated_at }));
  }
  async function historyItem(userId, key) {
    await historyWrites.get(userId);
    return (await database.pool.query("SELECT media,position,duration FROM watch_history WHERE user_id=$1 AND content_key=$2", [userId, key])).rows[0];
  }
  function deleteHistory(userId, key) {
    return queueHistory(userId, async () => (await database.pool.query("DELETE FROM watch_history WHERE user_id=$1 AND content_key=$2", [userId, key])).rowCount > 0);
  }
  function cleanHistory(userId, isAvailable) {
    return queueHistory(userId, async () => {
      const result = await database.pool.query("SELECT content_key,media FROM watch_history WHERE user_id=$1", [userId]);
      const keys = result.rows.filter((row) => !isAvailable(row.media)).map((row) => row.content_key);
      if (!keys.length) return 0;
      return (await database.pool.query("DELETE FROM watch_history WHERE user_id=$1 AND content_key=ANY($2::text[])", [userId, keys])).rowCount;
    });
  }
  async function saveRoom(id, data) {
    await database.pool.query("INSERT INTO rooms(id,data) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data,updated_at=now()", [id, JSON.stringify(data)]);
  }
  async function loadRooms() {
    return (await database.pool.query("SELECT data FROM rooms WHERE updated_at>now()-interval '24 hours' ORDER BY updated_at DESC LIMIT 1000")).rows.map(row => row.data);
  }
  async function deleteRoom(id) { await database.pool.query("DELETE FROM rooms WHERE id=$1", [id]); }
  async function room(id) { return (await database.pool.query("SELECT data FROM rooms WHERE id=$1 AND updated_at>now()-interval '24 hours'", [id])).rows[0]?.data; }
  return { register, login, getUser, logout, recordHistory, history, historyItem, deleteHistory, cleanHistory, saveRoom, loadRooms, deleteRoom, room, sessionKey: request => { const token = cookieToken(request); return token ? tokenHash(token) : ""; }, flush: () => Promise.all([...historyWrites.values()]) };
}
