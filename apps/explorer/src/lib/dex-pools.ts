import type { Address, Hex } from 'viem'
import * as z from 'zod/mini'

/**
 * How swaps treat a book. A base token routes through the book against its
 * `quoteToken()`; a book against its staged `nextQuoteToken()` accepts orders
 * but no swaps (TIP-1001); any other book is left over from an earlier quote.
 */
export type DexPoolStatus = 'active' | 'place-only' | 'retired'

export type DexPoolToken = {
	address: Address
	symbol: string
	decimals: number
	verified: boolean
}

export type DexPoolVolume = { day: number; month: number }

export type DexPool = {
	key: Hex
	base: DexPoolToken
	quote: DexPoolToken
	status: DexPoolStatus
	/** Best prices in quote per base, or null when that side is empty. */
	bid: number | null
	ask: number | null
	/**
	 * Resting orders at par: bids in quote-token units, asks in base-token
	 * units. Null for books swaps don't route through, or that could not be
	 * read.
	 */
	liquidity: {
		bid: number
		ask: number
		total: number
		/** Some reads failed or were capped, so the total is a lower bound. */
		partial: boolean
	} | null
	volume: DexPoolVolume
}

export type DexPoolsSnapshot = {
	blockNumber: string
	generatedAt: number
	pools: DexPool[]
}

export const emptyVolume: DexPoolVolume = { day: 0, month: 0 }

/** Adds to a keyed list in place. */
export function append<key, value>(
	map: Map<key, value[]>,
	key: key,
	value: value,
): void {
	const list = map.get(key)
	if (list) list.push(value)
	else map.set(key, [value])
}

const equal = (a: string | null | undefined, b: string | null | undefined) =>
	Boolean(a && b && a.toLowerCase() === b.toLowerCase())

export function bookStatus(
	quote: Address,
	base: { quoteToken: Address; nextQuoteToken: Address },
): DexPoolStatus {
	if (equal(quote, base.quoteToken)) return 'active'
	if (equal(quote, base.nextQuoteToken)) return 'place-only'
	return 'retired'
}

/** `price = (PRICE_SCALE + tick) / PRICE_SCALE`, quote per base. */
export function tickPrice(tick: number): number {
	return (100_000 + tick) / 100_000
}

export function spreadBps(bid: number | null, ask: number | null) {
	if (bid === null || ask === null) return null
	return ((ask - bid) / ((ask + bid) / 2)) * 10_000
}

/**
 * Values one side of a book. Tick liquidity is base-denominated; resting
 * bids lock quote tokens at their tick price, rescaled to quote decimals.
 */
export function sideValue(
	levels: readonly { tick: number; liquidity: bigint }[],
	options: { isBid: boolean; baseDecimals: number; quoteDecimals: number },
): bigint {
	let total = 0n
	for (const { tick, liquidity } of levels) {
		if (!options.isBid) {
			total += liquidity
			continue
		}
		const quote = (liquidity * BigInt(100_000 + tick)) / 100_000n
		total +=
			options.quoteDecimals >= options.baseDecimals
				? quote * 10n ** BigInt(options.quoteDecimals - options.baseDecimals)
				: quote / 10n ** BigInt(options.baseDecimals - options.quoteDecimals)
	}
	return total
}

/**
 * Splits a base token's fills between its books. Swaps only route through
 * the book against the current quote token, so fills after the latest
 * quote-token switch belong to it and earlier fills to the previous book.
 */
export function attributeVolume(input: {
	quote: Address
	routedQuote: Address
	previousQuote: Address | null
	total: DexPoolVolume | undefined
	beforeSwitch: DexPoolVolume | undefined
}): DexPoolVolume {
	const total = input.total ?? emptyVolume
	// With no known earlier book, pre-switch fills stay with the routed book
	// rather than dropping out of every total.
	const before = (input.previousQuote && input.beforeSwitch) || emptyVolume
	if (equal(input.quote, input.routedQuote))
		return {
			day: Math.max(0, total.day - before.day),
			month: Math.max(0, total.month - before.month),
		}
	if (equal(input.quote, input.previousQuote)) return before
	return emptyVolume
}

/**
 * The quote a base routed through before its latest switch: the target of
 * the switch before it, or else its only book against neither the current
 * nor the staged quote.
 */
export function previousQuote(input: {
	updates: readonly Address[]
	books: readonly Address[]
	routedQuote: Address
	nextQuote: Address
}): Address | null {
	if (input.updates.length > 1) return input.updates[1] ?? null
	const others = input.books.filter(
		(quote) =>
			!equal(quote, input.routedQuote) && !equal(quote, input.nextQuote),
	)
	return others.length === 1 ? (others[0] ?? null) : null
}

export const dexPoolSorts = ['liquidity', 'spread', 'day', 'month'] as const

export type DexPoolSort = (typeof dexPoolSorts)[number]

export const dexPoolsSearchSchema = z.object({
	tab: z._default(z.enum(['pairs', 'swaps']), 'pairs'),
	sort: z._default(z.enum(dexPoolSorts), 'liquidity'),
	dir: z._default(z.enum(['asc', 'desc']), 'desc'),
	unverified: z._default(z.boolean(), false),
})

export type DexPoolsSearch = z.infer<typeof dexPoolsSearchSchema>

export const defaultDexPoolsSearch: DexPoolsSearch = {
	tab: 'pairs',
	sort: 'liquidity',
	dir: 'desc',
	unverified: false,
}

function sortValue(pool: DexPool, sort: DexPoolSort): number | null {
	// A partial zero is unreadable, not empty, and is shown as unknown.
	if (sort === 'liquidity')
		return !pool.liquidity ||
			(pool.liquidity.partial && pool.liquidity.total === 0)
			? null
			: pool.liquidity.total
	if (sort === 'spread') return spreadBps(pool.bid, pool.ask)
	return pool.volume[sort]
}

/** Unknown values sort last in either direction. */
export function sortPools(
	pools: readonly DexPool[],
	sort: DexPoolSort,
	dir: 'asc' | 'desc',
): DexPool[] {
	return [...pools].sort((a, b) => {
		const left = sortValue(a, sort)
		const right = sortValue(b, sort)
		if (left === null || right === null)
			return left === right ? 0 : left === null ? 1 : -1
		return (dir === 'asc' ? left - right : right - left) || 0
	})
}

export function matchesPoolQuery(pool: DexPool, query: string): boolean {
	const needle = query.trim().toLowerCase()
	if (!needle) return true
	return [pool.base, pool.quote].some(
		(token) =>
			token.symbol.toLowerCase().includes(needle) ||
			token.address.toLowerCase() === needle,
	)
}
