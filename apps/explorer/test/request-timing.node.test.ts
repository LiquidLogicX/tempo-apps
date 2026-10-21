import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withRequestTiming } from '../src/lib/server/request-timing'

const request = new Request(
	'https://explore.tempo.xyz/tx/0x123abc?token=private',
	{ headers: { authorization: 'secret' } },
)
const env = { POSTHOG_API_KEY: 'server-token', VITE_TEMPO_ENV: 'mainnet' }
const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
	vi.spyOn(Math, 'random').mockReturnValue(0)
	vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValue(142)
	vi.stubGlobal('fetch', fetchMock)
	fetchMock.mockResolvedValue(new Response(null))
})

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	fetchMock.mockReset()
})

describe('Worker request timings', () => {
	it('returns the response without waiting for delivery and only sends server metadata', async () => {
		let complete: ((response: Response) => void) | undefined
		fetchMock.mockReturnValue(
			new Promise((resolve) => {
				complete = resolve
			}),
		)
		const waitUntil = vi.fn()
		const response = new Response('application body', { status: 201 })
		expect(
			await withRequestTiming(
				request,
				env,
				{ waitUntil },
				async () => response,
			),
		).toBe(response)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			'https://us.i.posthog.com/capture/',
		)
		const options = fetchMock.mock.calls[0]?.[1]
		expect(options?.method).toBe('POST')
		expect(options?.signal).toBeInstanceOf(AbortSignal)
		expect(JSON.parse(String(options?.body))).toEqual({
			api_key: 'server-token',
			event: 'explorer.server.request_duration',
			properties: {
				distinct_id: 'explorer-server',
				$process_person_profile: false,
				$geoip_disable: true,
				duration_ms: 42,
				environment: 'mainnet',
				method: 'GET',
				route_pattern: '/tx/:hash',
				status_code: 201,
				sample_rate: 0.25,
				tempo_app_id: 'explorer-server',
				tempo_runtime: 'worker',
			},
		})
		expect(waitUntil).toHaveBeenCalledTimes(1)
		complete?.(new Response(null))
		await waitUntil.mock.calls[0]?.[0]
	})

	it('preserves thrown application errors and records a server failure', async () => {
		const error = new Error('application failure')
		const waitUntil = vi.fn()
		await expect(
			withRequestTiming(request, env, { waitUntil }, async () => {
				throw error
			}),
		).rejects.toBe(error)
		expect(
			JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).properties
				.status_code,
		).toBe(500)
		await waitUntil.mock.calls[0]?.[0]
	})

	it.each([
		'network',
		'upstream',
	])('keeps %s delivery failures out of the application response', async (failure) => {
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		if (failure === 'network') fetchMock.mockRejectedValue(new Error('offline'))
		else fetchMock.mockResolvedValue(new Response(null, { status: 503 }))
		const waitUntil = vi.fn()
		const response = new Response('ok')
		expect(
			await withRequestTiming(
				request,
				env,
				{ waitUntil },
				async () => response,
			),
		).toBe(response)
		await expect(waitUntil.mock.calls[0]?.[0]).resolves.toBeUndefined()
		expect(console.warn).toHaveBeenCalledWith(
			'Explorer request timing delivery failed',
		)
	})

	it.each([
		'/dd-proxy',
		'/assets/chunk.js',
		'/favicon.ico',
		'/robots.txt',
	])('does not capture %s', async (path) => {
		const waitUntil = vi.fn()
		const response = new Response('ok')
		expect(
			await withRequestTiming(
				new Request(`https://explore.tempo.xyz${path}`),
				env,
				{ waitUntil },
				async () => response,
			),
		).toBe(response)
		expect(fetchMock).not.toHaveBeenCalled()
		expect(waitUntil).not.toHaveBeenCalled()
	})

	it('does not capture without a configured secret or outside the sample', async () => {
		const waitUntil = vi.fn()
		const handle = vi.fn(async () => new Response('ok'))
		await withRequestTiming(request, {}, { waitUntil }, handle)
		vi.spyOn(Math, 'random').mockReturnValue(0.25)
		await withRequestTiming(request, env, { waitUntil }, handle)
		expect(handle).toHaveBeenCalledTimes(2)
		expect(fetchMock).not.toHaveBeenCalled()
		expect(waitUntil).not.toHaveBeenCalled()
	})

	it('normalizes block numbers', async () => {
		const waitUntil = vi.fn()
		await withRequestTiming(
			new Request('https://explore.tempo.xyz/block/12345'),
			env,
			{ waitUntil },
			async () => new Response(null),
		)
		expect(
			JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).properties
				.route_pattern,
		).toBe('/block/:id')
		await waitUntil.mock.calls[0]?.[0]
	})
})
