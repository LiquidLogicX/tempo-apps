import { createServerFn } from '@tanstack/react-start'
import { type Address, formatUnits, type Hex } from 'viem'
import { Tick } from 'viem/tempo'
import {
	attributeVolume,
	bookStatus,
	type DexPool,
	type DexPoolsSnapshot,
	type DexPoolToken,
	type DexPoolVolume,
	previousQuote,
	sideValue,
	tickPrice,
} from '#lib/dex-pools'
import {
	addressOf,
	dex,
	indexer,
	list,
	type Row,
	readContracts,
	readQuoteSwitches,
	readTokens,
	sqlTime,
} from '#lib/server/dex-indexer'
import { withDeadline } from '#lib/server/dex-route'
import { withImmutableDataCache } from '#lib/server/immutable-data-cache'
import { getBatchedClient, getTempoChain } from '#wagmi.config'

/**
 * Pairs are discovered from the indexer rather than listed exhaustively:
 * every TIP-20 can create a pair, so most of the chain's books are empty.
 * The bases with the most DEX-held balance and the most recent volume cover
 * the books worth showing, and every book of those bases is included.
 */
const BASES_BY_BALANCE = 20
const BASES_BY_VOLUME = 20

/**
 * A book whose levels hold long order queues can take longer to read than
 * the page should wait; it is shown as unreadable instead of failing the page.
 */
const DEPTH_DEADLINE = 6_000

const hexKey = /^0x[0-9a-f]{64}$/

function volumeColumns(windows: { day: string }) {
	return `toString(sumIf(quote_volume, bucket >= '${windows.day}')) AS day,
		toString(sum(quote_volume)) AS month`
}

type RawVolume = { day: bigint; month: bigint }

function volumesByToken(rows: Row[]): Map<Address, RawVolume> {
	const volumes = new Map<Address, RawVolume>()
	for (const row of rows) {
		const token = addressOf(row.token)
		if (!token) continue
		volumes.set(token, {
			day: BigInt(String(row.day)),
			month: BigInt(String(row.month)),
		})
	}
	return volumes
}

/** Fill volume is base-denominated ticks times price, so base decimals apply. */
function toVolume(
	raw: RawVolume | undefined,
	decimals: number,
): DexPoolVolume | undefined {
	if (!raw) return undefined
	return {
		day: Number(formatUnits(raw.day, decimals)),
		month: Number(formatUnits(raw.month, decimals)),
	}
}

export async function getDexPools(): Promise<DexPoolsSnapshot> {
	const chainId = getTempoChain().id
	const client = getBatchedClient()
	const now = Date.now()
	const windows = {
		day: sqlTime(now - 86_400_000),
		month: sqlTime(now - 30 * 86_400_000),
	}

	const [byBalance, byVolume, blockNumber] = await Promise.all([
		indexer(
			chainId,
			`SELECT base FROM dex_pair_liquidity WHERE liquidity > 0
			GROUP BY base ORDER BY max(liquidity) DESC LIMIT ${BASES_BY_BALANCE}`,
		),
		indexer(
			chainId,
			`SELECT token FROM dex_ohlc_1m WHERE bucket >= '${windows.month}'
			GROUP BY token ORDER BY sum(quote_volume) DESC LIMIT ${BASES_BY_VOLUME}`,
		),
		client.getBlockNumber(),
	])
	const bases = new Set(
		[
			...byBalance.map((row) => addressOf(row.base)),
			...byVolume.map((row) => addressOf(row.token)),
		].filter((base) => base !== undefined),
	)
	if (bases.size === 0)
		return { blockNumber: String(blockNumber), generatedAt: now, pools: [] }

	const [pairRows, updates, volumeRows] = await Promise.all([
		indexer(
			chainId,
			`SELECT key, base, quote FROM dex_pairs WHERE base IN (${list(bases)})`,
		),
		readQuoteSwitches(chainId, bases),
		indexer(
			chainId,
			`SELECT token, ${volumeColumns(windows)} FROM dex_ohlc_1m
			WHERE bucket >= '${windows.month}' AND token IN (${list(bases)})
			GROUP BY token`,
		),
	])

	const pairs = pairRows.flatMap((row) => {
		const key = String(row.key).toLowerCase()
		const base = addressOf(row.base)
		const quote = addressOf(row.quote)
		if (!hexKey.test(key) || !base || !quote) return []
		return [{ key: key as Hex, base, quote }]
	})
	// Fills before a switch inside the window went to the previous book.
	const switches = [...updates]
		.map(([base, list]) => ({ base, at: list[0]?.at ?? 0 }))
		.filter((entry) => entry.at * 1000 > now - 30 * 86_400_000)

	const tokens = [...new Set(pairs.flatMap((pair) => [pair.base, pair.quote]))]
	const [metadata, books, levelRows, beforeSwitchRows] = await Promise.all([
		readTokens(chainId, tokens, blockNumber),
		readContracts(
			pairs.map((pair) => ({
				...dex,
				functionName: 'books' as const,
				args: [pair.key] as const,
			})),
			blockNumber,
		),
		// Orders only rest where they were placed or flip to, so these are the
		// only levels worth reading. Null when unknown, so depth is marked partial.
		indexer(
			chainId,
			`SELECT token, "isBid" AS bid, tick FROM dex_orders
			WHERE token IN (${list(bases)}) GROUP BY token, "isBid", tick
			UNION ALL
			SELECT token, 1 - "isBid" AS bid, "flipTick" AS tick FROM dex_orders
			WHERE token IN (${list(bases)}) AND "isFlipOrder" = 1
			GROUP BY token, "isBid", "flipTick"`,
		).catch((error) => {
			console.error('Failed to read DEX order levels:', error)
			return null
		}),
		switches.length
			? indexer(
					chainId,
					`SELECT token, ${volumeColumns(windows)} FROM dex_ohlc_1m
					WHERE bucket >= '${windows.month}' AND (${switches
						.map(
							(entry) =>
								`(token = '${entry.base}' AND bucket < '${sqlTime(entry.at * 1000)}')`,
						)
						.join(' OR ')})
					GROUP BY token`,
				)
			: Promise.resolve([]),
	])

	const usedTicks = new Map<Address, { bids: Set<number>; asks: Set<number> }>()
	for (const row of levelRows ?? []) {
		const base = addressOf(row.token)
		const tick = Number(row.tick)
		if (!base || !Number.isInteger(tick)) continue
		const levels = usedTicks.get(base) ?? { bids: new Set(), asks: new Set() }
		levels[Number(row.bid) === 1 ? 'bids' : 'asks'].add(tick)
		usedTicks.set(base, levels)
	}

	const totals = volumesByToken(volumeRows)
	const beforeSwitch = volumesByToken(beforeSwitchRows)
	const booksByBase = new Map<Address, Address[]>()
	for (const pair of pairs)
		booksByBase.set(pair.base, [
			...(booksByBase.get(pair.base) ?? []),
			pair.quote,
		])

	const valid = (tick: number) => tick >= Tick.minTick && tick <= Tick.maxTick
	const entries = pairs.flatMap((pair, index) => {
		const base = metadata.get(pair.base)
		const quote = metadata.get(pair.quote)
		const book = books[index]
		if (!base || !quote || book?.status !== 'success') return []
		return [{ pair, base, quote, book: book.result }]
	})
	// Only the routed book is listed; `getTickLevel` can read no other.
	const depths = await Promise.all(
		entries.map((entry) =>
			bookStatus(entry.pair.quote, entry.base) === 'active'
				? orNull(
						readDepth({
							base: entry.base.token,
							quote: entry.quote.token,
							bestBidTick: entry.book.bestBidTick,
							bestAskTick: entry.book.bestAskTick,
							used: levelRows
								? (usedTicks.get(entry.pair.base) ?? {
										bids: new Set(),
										asks: new Set(),
									})
								: undefined,
							blockNumber,
						}),
						DEPTH_DEADLINE,
					)
				: null,
		),
	)

	const pools = entries.map(({ pair, base, quote, book }, index): DexPool => {
		const status = bookStatus(pair.quote, base)
		return {
			key: pair.key,
			base: base.token,
			quote: quote.token,
			status,
			bid: valid(book.bestBidTick) ? tickPrice(book.bestBidTick) : null,
			ask: valid(book.bestAskTick) ? tickPrice(book.bestAskTick) : null,
			liquidity: depths[index] ?? null,
			volume: attributeVolume({
				quote: pair.quote,
				routedQuote: base.quoteToken,
				previousQuote: previousQuote({
					updates: (updates.get(pair.base) ?? []).map((entry) => entry.quote),
					books: booksByBase.get(pair.base) ?? [],
					routedQuote: base.quoteToken,
					nextQuote: base.nextQuoteToken,
				}),
				total: toVolume(totals.get(pair.base), base.token.decimals),
				beforeSwitch: toVolume(
					beforeSwitch.get(pair.base),
					base.token.decimals,
				),
			}),
		}
	})
	return { blockNumber: String(blockNumber), generatedAt: now, pools }
}

function orNull<T>(read: Promise<T>, ms: number): Promise<T | null> {
	let timer: ReturnType<typeof setTimeout> | undefined
	return Promise.race([
		read,
		new Promise<null>((resolve) => {
			timer = setTimeout(() => resolve(null), ms)
		}),
	]).finally(() => clearTimeout(timer))
}

function toLiquidity(
	bids: bigint,
	asks: bigint,
	tokens: { base: DexPoolToken; quote: DexPoolToken },
	partial: boolean,
): NonNullable<DexPool['liquidity']> {
	const bid = Number(formatUnits(bids, tokens.quote.decimals))
	const ask = Number(formatUnits(asks, tokens.base.decimals))
	return { bid, ask, total: bid + ask, partial }
}

/**
 * Sums the routed book's levels from each side's best price outward.
 * `getTickLevel` resolves the base's routed book, so only active books can
 * be read this way. Without the used-tick list only the best levels are
 * read and the total is marked partial.
 */
async function readDepth(input: {
	base: DexPoolToken
	quote: DexPoolToken
	bestBidTick: number
	bestAskTick: number
	used: { bids: Set<number>; asks: Set<number> } | undefined
	blockNumber: bigint
}): Promise<NonNullable<DexPool['liquidity']>> {
	const valid = (tick: number) => tick >= Tick.minTick && tick <= Tick.maxTick
	// The best bid is the highest resting bid and the best ask the lowest ask.
	const bids = valid(input.bestBidTick)
		? [...new Set([input.bestBidTick, ...(input.used?.bids ?? [])])].filter(
				(tick) => valid(tick) && tick <= input.bestBidTick,
			)
		: []
	const asks = valid(input.bestAskTick)
		? [...new Set([input.bestAskTick, ...(input.used?.asks ?? [])])].filter(
				(tick) => valid(tick) && tick >= input.bestAskTick,
			)
		: []
	const levels = [
		...bids.map((tick) => ({ tick, isBid: true })),
		...asks.map((tick) => ({ tick, isBid: false })),
	]
	const results = await readContracts(
		levels.map(({ tick, isBid }) => ({
			...dex,
			functionName: 'getTickLevel' as const,
			args: [input.base.address, tick, isBid] as const,
		})),
		input.blockNumber,
	)
	const read = levels.flatMap((level, index) => {
		const result = results[index]
		return result?.status === 'success'
			? [{ ...level, liquidity: result.result[2] }]
			: []
	})
	const options = {
		baseDecimals: input.base.decimals,
		quoteDecimals: input.quote.decimals,
	}
	return toLiquidity(
		sideValue(
			read.filter((level) => level.isBid),
			{ ...options, isBid: true },
		),
		sideValue(
			read.filter((level) => !level.isBid),
			{ ...options, isBid: false },
		),
		input,
		read.length < levels.length || !input.used,
	)
}

export const fetchDexPools = createServerFn({ method: 'GET' }).handler(
	async (): Promise<DexPoolsSnapshot> => {
		try {
			return await withImmutableDataCache({
				key: `dex-pools:v1:${getTempoChain().id}`,
				ttlSeconds: 30,
				load: () => withDeadline(getDexPools()),
				// Partial snapshots are cached too: re-reading a book that just
				// timed out would only add load until the short TTL expires.
				shouldCache: (snapshot) => snapshot.pools.length > 0,
			})
		} catch (error) {
			console.error('Failed to load Stablecoin DEX pairs:', error)
			throw new Error(
				'Stablecoin DEX pairs are temporarily unavailable. Please try again.',
			)
		}
	},
)
