import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000

export type Side = "BUY" | "SELL"

export type TradeInput = {
   txHash: string
   logIndex: number
   wallet: string
   tokenId: string
   conditionId: string
   side: Side
   shares: number
   usdc: number
   price: number
   blockNumber: number
}

export type TokenRow = {
   tokenId: string
   conditionId: string
   eventSlug: string | null
   marketSlug: string | null
   title: string | null
   outcome: string | null
   startTime: number | null
   fetchedAt: number
}

export type ExposureRow = {
   conditionId: string
   entryCostUsdc: number
   shares: number
}

export type ClosedRow = {
   conditionId: string
   title: string
   outcome: string
   realizedPnl: number
   lastEventAt: number
}

export type PnlRow = {
   realizedPnl: number
   unrealizedPnl: number
}

export type TrackedWallet = {
   address: string
   nickname: string | null
   polymarketName: string | null
}

export type PriorTrade = {
   tokenId: string
   side: Side
   createdAt: number
}

export class Db {
   private db: Database

   constructor(path: string) {
      mkdirSync(dirname(path), { recursive: true })
      this.db = new Database(path)
      this.db.exec("PRAGMA journal_mode = WAL")
      this.db.exec(`
         CREATE TABLE IF NOT EXISTS tracked (
            discord_id TEXT NOT NULL,
            address TEXT NOT NULL,
            nickname TEXT,
            polymarket_name TEXT,
            realized_pnl REAL,
            unrealized_pnl REAL,
            pnl_updated_at INTEGER,
            PRIMARY KEY (discord_id, address)
         );
         CREATE TABLE IF NOT EXISTS trades (
            tx_hash TEXT NOT NULL,
            log_index INTEGER NOT NULL,
            wallet TEXT NOT NULL,
            token_id TEXT NOT NULL,
            condition_id TEXT NOT NULL,
            side TEXT NOT NULL,
            shares REAL NOT NULL,
            usdc REAL NOT NULL,
            price REAL NOT NULL,
            block_number INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (tx_hash, log_index, wallet)
         );
         CREATE TABLE IF NOT EXISTS tokens (
            token_id TEXT PRIMARY KEY,
            condition_id TEXT NOT NULL,
            event_slug TEXT,
            market_slug TEXT,
            title TEXT,
            outcome TEXT,
            start_time INTEGER,
            fetched_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS exposure (
            wallet TEXT NOT NULL,
            condition_id TEXT NOT NULL,
            entry_cost_usdc REAL NOT NULL,
            shares REAL NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (wallet, condition_id)
         );
         CREATE TABLE IF NOT EXISTS closed_positions (
            wallet TEXT NOT NULL,
            condition_id TEXT NOT NULL,
            title TEXT NOT NULL,
            outcome TEXT NOT NULL,
            realized_pnl REAL NOT NULL,
            last_event_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS cursor (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            block_number INTEGER NOT NULL
         );
      `)
   }

   track(discordId: string, address: string) {
      this.db.query("INSERT OR IGNORE INTO tracked (discord_id, address) VALUES (?, ?)").run(discordId, address)
   }

   untrack(discordId: string, address: string) {
      this.db.query("DELETE FROM tracked WHERE discord_id = ? AND address = ?").run(discordId, address)
   }

   listForUser(discordId: string): TrackedWallet[] {
      const rows = this.db.query(
         "SELECT address, nickname, polymarket_name FROM tracked WHERE discord_id = ? ORDER BY address",
      ).all(discordId) as { address: string, nickname: string | null, polymarket_name: string | null }[]
      return rows.map(row => ({
         address: row.address,
         nickname: row.nickname,
         polymarketName: row.polymarket_name,
      }))
   }

   tracks(discordId: string, address: string): boolean {
      const row = this.db.query(
         "SELECT 1 AS ok FROM tracked WHERE discord_id = ? AND address = ?",
      ).get(discordId, address) as { ok: number } | null
      return row !== null
   }

   getNickname(discordId: string, address: string): string | null {
      return this.walletIdentity(discordId, address)?.nickname ?? null
   }

   getPolymarketName(address: string): string | null {
      const row = this.db.query(
         "SELECT polymarket_name FROM tracked WHERE address = ? AND polymarket_name IS NOT NULL LIMIT 1",
      ).get(address) as { polymarket_name: string } | null
      return row?.polymarket_name ?? null
   }

   walletIdentity(discordId: string, address: string): { nickname: string | null, polymarketName: string | null } | null {
      const row = this.db.query(
         "SELECT nickname, polymarket_name FROM tracked WHERE discord_id = ? AND address = ?",
      ).get(discordId, address) as { nickname: string | null, polymarket_name: string | null } | null
      if (!row) return null
      return { nickname: row.nickname, polymarketName: row.polymarket_name }
   }

   setPolymarketName(address: string, name: string) {
      this.db.query("UPDATE tracked SET polymarket_name = ? WHERE address = ?").run(name, address)
   }

   setNickname(discordId: string, address: string, nickname: string): boolean {
      const result = this.db.query(
         "UPDATE tracked SET nickname = ? WHERE discord_id = ? AND address = ?",
      ).run(nickname, discordId, address)
      return result.changes === 1
   }

   lastOnCondition(wallet: string, conditionId: string): PriorTrade | null {
      const row = this.db.query(`
         SELECT token_id, side, created_at FROM trades
         WHERE wallet = ? AND condition_id = ? AND created_at IS NOT NULL
         ORDER BY created_at DESC
         LIMIT 1
      `).get(wallet, conditionId) as { token_id: string, side: Side, created_at: number } | null
      if (!row) return null
      return { tokenId: row.token_id, side: row.side, createdAt: row.created_at }
   }

   lastAlertAt(wallet: string): number | null {
      const row = this.db.query(
         "SELECT created_at FROM trades WHERE wallet = ? ORDER BY created_at DESC LIMIT 1",
      ).get(wallet) as { created_at: number } | null
      return row?.created_at ?? null
   }

   trackedAddresses(): string[] {
      const rows = this.db.query("SELECT DISTINCT address FROM tracked ORDER BY address").all() as { address: string }[]
      return rows.map(row => row.address)
   }

   subscribers(address: string): string[] {
      const rows = this.db.query("SELECT discord_id FROM tracked WHERE address = ?").all(address) as { discord_id: string }[]
      return rows.map(row => row.discord_id)
   }

   isTracked(address: string): boolean {
      const row = this.db.query("SELECT 1 AS ok FROM tracked WHERE address = ? LIMIT 1").get(address) as { ok: number } | null
      return row !== null
   }

   hasTrade(txHash: string, logIndex: number, wallet: string): boolean {
      const row = this.db.query("SELECT 1 AS ok FROM trades WHERE tx_hash = ? AND log_index = ? AND wallet = ?").get(txHash, logIndex, wallet) as { ok: number } | null
      return row !== null
   }

   insertTrade(trade: TradeInput): boolean {
      const result = this.db.query(`
         INSERT OR IGNORE INTO trades (
            tx_hash, log_index, wallet, token_id, condition_id, side, shares, usdc, price, block_number, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
         trade.txHash,
         trade.logIndex,
         trade.wallet,
         trade.tokenId,
         trade.conditionId,
         trade.side,
         trade.shares,
         trade.usdc,
         trade.price,
         trade.blockNumber,
         Date.now(),
      )
      return result.changes === 1
   }

   getToken(tokenId: string): TokenRow | null {
      const row = this.db.query("SELECT * FROM tokens WHERE token_id = ?").get(tokenId) as TokenSql | null
      if (!row) return null
      if (Date.now() - row.fetched_at > TOKEN_TTL_MS) return null
      return mapToken(row)
   }

   upsertToken(token: TokenRow) {
      this.db.query(`
         INSERT INTO tokens (
            token_id, condition_id, event_slug, market_slug, title, outcome, start_time, fetched_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(token_id) DO UPDATE SET
            condition_id = excluded.condition_id,
            event_slug = excluded.event_slug,
            market_slug = excluded.market_slug,
            title = excluded.title,
            outcome = excluded.outcome,
            start_time = excluded.start_time,
            fetched_at = excluded.fetched_at
      `).run(
         token.tokenId,
         token.conditionId,
         token.eventSlug,
         token.marketSlug,
         token.title,
         token.outcome,
         token.startTime,
         token.fetchedAt,
      )
   }

   applyFill(wallet: string, conditionId: string, side: Side, usdc: number, shares: number) {
      const current = this.db.query(
         "SELECT entry_cost_usdc, shares FROM exposure WHERE wallet = ? AND condition_id = ?",
      ).get(wallet, conditionId) as { entry_cost_usdc: number, shares: number } | null
      let cost = current?.entry_cost_usdc ?? 0
      let size = current?.shares ?? 0
      if (side === "BUY") {
         cost += usdc
         size += shares
      } else {
         cost = Math.max(0, cost - usdc)
         size = Math.max(0, size - shares)
      }
      this.db.query(`
         INSERT INTO exposure (wallet, condition_id, entry_cost_usdc, shares, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(wallet, condition_id) DO UPDATE SET
            entry_cost_usdc = excluded.entry_cost_usdc,
            shares = excluded.shares,
            updated_at = excluded.updated_at
      `).run(wallet, conditionId, cost, size, Date.now())
   }

   getExposure(wallet: string, conditionId: string): ExposureRow | null {
      const row = this.db.query(
         "SELECT condition_id, entry_cost_usdc, shares FROM exposure WHERE wallet = ? AND condition_id = ?",
      ).get(wallet, conditionId) as { condition_id: string, entry_cost_usdc: number, shares: number } | null
      if (!row) return null
      return { conditionId: row.condition_id, entryCostUsdc: row.entry_cost_usdc, shares: row.shares }
   }

   replaceExposure(wallet: string, rows: ExposureRow[]) {
      const remove = this.db.query("DELETE FROM exposure WHERE wallet = ?")
      const now = Date.now()
      const insert = this.db.query(
         "INSERT INTO exposure (wallet, condition_id, entry_cost_usdc, shares, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      this.db.transaction(() => {
         remove.run(wallet)
         for (const row of rows) insert.run(wallet, row.conditionId, row.entryCostUsdc, row.shares, now)
      })()
   }

   replaceClosed(wallet: string, rows: ClosedRow[]) {
      const remove = this.db.query("DELETE FROM closed_positions WHERE wallet = ?")
      const now = Date.now()
      const insert = this.db.query(`
         INSERT INTO closed_positions (wallet, condition_id, title, outcome, realized_pnl, last_event_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      this.db.transaction(() => {
         remove.run(wallet)
         for (const row of rows) {
            insert.run(wallet, row.conditionId, row.title, row.outcome, row.realizedPnl, row.lastEventAt, now)
         }
      })()
   }

   getClosed(wallet: string): ClosedRow[] {
      const rows = this.db.query(`
         SELECT condition_id, title, outcome, realized_pnl, last_event_at
         FROM closed_positions WHERE wallet = ? ORDER BY last_event_at DESC
      `).all(wallet) as { condition_id: string, title: string, outcome: string, realized_pnl: number, last_event_at: number }[]
      return rows.map(row => ({
         conditionId: row.condition_id,
         title: row.title,
         outcome: row.outcome,
         realizedPnl: row.realized_pnl,
         lastEventAt: row.last_event_at,
      }))
   }

   setPnl(wallet: string, pnl: PnlRow) {
      this.db.query(`
         UPDATE tracked SET realized_pnl = ?, unrealized_pnl = ?, pnl_updated_at = ? WHERE address = ?
      `).run(pnl.realizedPnl, pnl.unrealizedPnl, Date.now(), wallet)
   }

   getPnl(wallet: string): PnlRow | null {
      const row = this.db.query(`
         SELECT realized_pnl, unrealized_pnl FROM tracked
         WHERE address = ? AND realized_pnl IS NOT NULL LIMIT 1
      `).get(wallet) as { realized_pnl: number, unrealized_pnl: number } | null
      if (!row) return null
      return { realizedPnl: row.realized_pnl, unrealizedPnl: row.unrealized_pnl }
   }

   prune() {
      const cutoff = Date.now() - TOKEN_TTL_MS
      this.db.query("DELETE FROM trades WHERE created_at < ?").run(cutoff)
      this.db.query("DELETE FROM tokens WHERE fetched_at < ?").run(cutoff)
      this.db.query("DELETE FROM exposure WHERE updated_at IS NULL OR updated_at < ?").run(cutoff)
      this.db.query("DELETE FROM closed_positions WHERE updated_at IS NULL OR updated_at < ?").run(cutoff)
   }

   getCursor(): number | null {
      const row = this.db.query("SELECT block_number FROM cursor WHERE id = 1").get() as { block_number: number } | null
      return row?.block_number ?? null
   }

   setCursor(blockNumber: number) {
      const current = this.getCursor()
      if (current !== null && blockNumber <= current) return
      this.db.query(`
         INSERT INTO cursor (id, block_number) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET block_number = excluded.block_number
      `).run(blockNumber)
   }
}

type TokenSql = {
   token_id: string
   condition_id: string
   event_slug: string | null
   market_slug: string | null
   title: string | null
   outcome: string | null
   start_time: string | number | null
   fetched_at: number
}

function mapToken(row: TokenSql): TokenRow {
   return {
      tokenId: row.token_id,
      conditionId: row.condition_id,
      eventSlug: row.event_slug,
      marketSlug: row.market_slug,
      title: row.title,
      outcome: row.outcome,
      startTime: unixSeconds(row.start_time),
      fetchedAt: row.fetched_at,
   }
}

function unixSeconds(value: string | number | null): number | null {
   if (value === null) return null
   if (typeof value === "number") return value
   const ms = Date.parse(value)
   return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}
