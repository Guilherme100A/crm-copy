// A suíte de contrato roda verde contra o FakeWaGateway (AC-T03-04), nas duas formas de fábrica.
import { FakeWaGateway } from '../testing/fake-gateway'
import { defineWaGatewayContract } from './suite'

defineWaGatewayContract(() => new FakeWaGateway())

defineWaGatewayContract('fake via harness', async () => {
  const gateway = new FakeWaGateway()
  return {
    gateway,
    connect: async (id: string) => {
      await gateway.connect(id, 'STABLE')
    },
    teardown: () => gateway.reset(),
  }
})

// T98: only/skip por grupo — o subconjunto roda e o resto entra como skip.
defineWaGatewayContract('fake, só sessões e cancel', () => new FakeWaGateway(), { only: ['sessions', 'cancel'] })
