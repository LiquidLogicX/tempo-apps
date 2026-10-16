import { createServerFn } from '@tanstack/react-start'
import { type Address, formatUnits, type Hex } from 'viem'
import { Addresses } from 'viem/tempo'
import * as z from 'zod/mini'
import { append } from '#lib/dex-pools'
import {
	type DexFill,
	type DexOrderState,
	type DexSwap,
	fillHop,
	groupSwaps,
	orderAt,
	quoteAt,
} from '#lib/dex-swaps'
import {
	addressOf,
	indexer,
	list,
	type Row,
	readQuoteSwitches,
	readTokens,
} from '#lib/server/dex-indexer'
import { withDeadline } from '#lib/server/dex-route'
import { withImmutableDataCache } from '#lib/server/immutable-data-cache'
import { zAddress } from '#lib/zod'
import { getBatchedClient, getTempoChain } from '#wagmi.config'

/** Recent fills to assemble; a swap is one or more fills. */
const FILLS = 400
const SWAPS = 25

const stablecoinDex = Addresses.stablecoinDex.toLowerCase()
const orderFlipped =
	'OrderFlipped(uint128 indexed orderId, address indexed maker, address indexed token, uint128 amount, bool isBid, int16 tick, int16 flipTick)'
const hexHash = /^0x[0-9a-f]{64}$/
const orderId = /^\d{1,39}$/

function orderStates(rows: Row[]): [string, DexOrderState][] {
	return rows.flatMap((row) => {
		const token = addressOf(row.token)
		const id = String(row.id)
		if (!token || !orderId.test(id)) return []
		return [
			[
				id,
				{
					block: Number(row.block_num),
					log: Number(row.log_idx),
					token,
					isBid: Number(row.bid) === 1,
					tick: Number(row.tick),
				},
			],
		]
	})
}

/**
 * Swaps are assembled from indexed fills rather than the Tempo API's swap
 * feed, which prices every fill against a base's first quote token and so
 * splits routes through a token that has since switched quote tokens.
 */
export async function getDexSwaps(
	input: DexSwapsInput = {},
): Promise<DexSwap[]> {
	const chainId = getTempoChain().id
	const path = input.path
	// A pair's swaps can fill on any book along its route.
	const onPath = path
		? `AND "orderId" IN (SELECT "orderId" FROM dex_orders
			WHERE address = '${stablecoinDex}' AND token IN (${list(path)}))`
		: ''
	const fillRows = await indexer(
		chainId,
		`SELECT block_num, log_idx, tx_hash, toUnixTimestamp(block_timestamp) AS ts,
		toString("orderId") AS id, taker, toString("amountFilled") AS amount
		FROM dex_fills WHERE address = '${stablecoinDex}' ${onPath}
		ORDER BY block_num DESC, log_idx DESC LIMIT ${FILLS}`,
	)
	const fills = fillRows.flatMap((row): DexFill[] => {
		const transactionHash = String(row.tx_hash).toLowerCase()
		const taker = addressOf(row.taker)
		const id = String(row.id)
		const amount = String(row.amount)
		if (!hexHash.test(transactionHash) || !taker || !orderId.test(id)) return []
		if (!/^\d+$/.test(amount)) return []
		return [
			{
				block: Number(row.block_num),
				log: Number(row.log_idx),
				transactionHash: transactionHash as Hex,
				timestamp: Number(row.ts),
				orderId: id,
				taker,
				amount: BigInt(amount),
			},
		]
	})
	if (fills.length === 0) return []

	const ids = [...new Set(fills.map((fill) => fill.orderId))].join(', ')
	const columns = `toString("orderId") AS id, token, "isBid" AS bid, tick, block_num, log_idx`
	const [placed, flipped, blockNumber] = await Promise.all([
		indexer(
			chainId,
			`SELECT ${columns} FROM dex_orders
			WHERE address = '${stablecoinDex}' AND "orderId" IN (${ids})`,
		),
		indexer(
			chainId,
			`SELECT ${columns} FROM orderflipped
			WHERE address = '${stablecoinDex}' AND "orderId" IN (${ids})`,
			orderFlipped,
		),
		getBatchedClient().getBlockNumber(),
	])
	const states = new Map<string, DexOrderState[]>()
	for (const [id, state] of [...orderStates(placed), ...orderStates(flipped)])
		append(states, id, state)

	const bases = new Set(
		[...states.values()].flatMap((list) => list.map((state) => state.token)),
	)
	if (bases.size === 0) return []
	const [switches, pairRows] = await Promise.all([
		readQuoteSwitches(chainId, bases),
		indexer(
			chainId,
			`SELECT base, quote FROM dex_pairs WHERE base IN (${list(bases)})`,
		),
	])
	const books = new Map<Address, Address[]>()
	for (const row of pairRows) {
		const base = addressOf(row.base)
		const quote = addressOf(row.quote)
		if (base && quote) append(books, base, quote)
	}
	const tokens = await readTokens(
		chainId,
		[...new Set([...bases, ...[...books.values()].flat()])],
		blockNumber,
	)

	/** Before its first switch a base quoted against its one other book. */
	function originalQuote(base: Address): Address | undefined {
		const history = switches.get(base) ?? []
		if (history.length === 0) return tokens.get(base)?.quoteToken
		const targets = new Set(history.map((entry) => entry.quote))
		const others = (books.get(base) ?? []).filter(
			(quote) => !targets.has(quote),
		)
		return others.length === 1 ? others[0] : undefined
	}

	const hops = fills.flatMap((fill) => {
		const order = orderAt(states.get(fill.orderId) ?? [], fill)
		const base = order && tokens.get(order.token)
		const original = order && originalQuote(order.token)
		if (!order || !base || !original) return []
		const quote = tokens.get(
			quoteAt(switches.get(order.token) ?? [], original, fill.timestamp),
		)
		if (!quote) return []
		return [
			{
				...fillHop(fill.amount, order, quote.token, base.token.decimals),
				transactionHash: fill.transactionHash,
				taker: fill.taker,
				timestamp: fill.timestamp,
				log: fill.log,
			},
		]
	})
	const [first, last] = path ? [path[0], path[path.length - 1]] : []
	return groupSwaps(hops)
		.filter(
			(row) =>
				!path ||
				(row.from === first && row.to === last) ||
				(row.from === last && row.to === first),
		)
		.flatMap((row): DexSwap[] => {
			const from = tokens.get(row.from)?.token
			const to = tokens.get(row.to)?.token
			if (!from || !to) return []
			return [
				{
					id: row.id,
					transactionHash: row.transactionHash,
					timestamp: row.timestamp,
					taker: row.taker,
					from,
					to,
					amountIn: Number(formatUnits(row.amountIn, from.decimals)),
					amountOut: Number(formatUnits(row.amountOut, to.decimals)),
				},
			]
		})
		.slice(0, SWAPS)
}

const inputSchema = z.object({
	path: z.optional(
		z
			.array(zAddress({ lowercase: true }))
			.check(z.minLength(2), z.maxLength(16)),
	),
})

/** Optionally only swaps between a route's two ends, in either direction. */
export type DexSwapsInput = z.infer<typeof inputSchema>

export const fetchDexSwaps = createServerFn({ method: 'GET' })
	.inputValidator((input: DexSwapsInput | undefined) =>
		inputSchema.parse(input ?? {}),
	)
	.handler(async ({ data }): Promise<DexSwap[]> => {
		try {
			return await withImmutableDataCache({
				key: `dex-swaps:v1:${getTempoChain().id}:${data.path?.join(',') ?? 'all'}`,
				ttlSeconds: 5,
				load: () => withDeadline(getDexSwaps(data)),
				shouldCache: (swaps) => swaps.length > 0,
			})
		} catch (error) {
			console.error('Failed to load Stablecoin DEX swaps:', error)
			throw new Error(
				'Stablecoin DEX swaps are temporarily unavailable. Please try again.',
			)
		}
	})
