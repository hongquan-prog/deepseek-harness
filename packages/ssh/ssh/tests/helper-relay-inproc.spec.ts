/** In-process relay publication covers the helper RPC without a child process. */
import { describe, expect, it } from 'vitest'
import { preparedSchema, relaySchema } from '../src/schemas.ts'
import { createHelperHarness } from './fixtures/helper.ts'

describe('SSH helper relay RPC', () => {
  it('publishes a loopback relay for a reserved stream endpoint', async () => {
    const helper = await createHelperHarness()
    try {
      const prepared = await helper.client.request('process.prepare', {
        argv: ['/bin/true'], cwd: helper.root, graceMs: 5_000,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      }, preparedSchema)
      const endpoint = prepared.streams.stdout
      if (endpoint === undefined) throw new Error('helper did not publish a stdout endpoint')
      const relay = await helper.client.request('stream.relay', { path: endpoint.path }, relaySchema)
      expect(relay.port).toBeGreaterThan(0)
    } finally { await helper.close() }
  })
})
