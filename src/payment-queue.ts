import { CONFIG } from './configs'

export class PaymentQueue {
  private queue: Payment[] = []
  private waitingResolvers: Array<{ resolve: () => void; timestamp: number }> =
    []
  private droppedCount = 0
  private processedCount = 0

  get length(): number {
    return this.queue.length
  }
  push(payment: Payment): boolean {
    if (this.queue.length >= CONFIG.MAX_QUEUE_SIZE) {
      this.droppedCount++
      return false
    }

    this.queue.push(payment)

    const waitingResolver = this.waitingResolvers.shift()
    if (waitingResolver) {
      waitingResolver.resolve()
    }

    return true
  }

  async dequeue(batchSize: number): Promise<Payment[]> {
    const now = Date.now()
    this.waitingResolvers = this.waitingResolvers.filter(
      resolver => now - resolver.timestamp < CONFIG.MAX_WAIT_TIME * 10
    )

    if (this.queue.length === 0) {
      await new Promise<void>(resolve => {
        this.waitingResolvers.push({
          resolve,
          timestamp: now
        })

        setTimeout(resolve, CONFIG.MAX_WAIT_TIME)
      })
    }

    const batchAmount = Math.min(batchSize, this.queue.length)
    const batch = this.queue.splice(0, batchAmount)

    if (batch.length > 0) {
      this.processedCount += batch.length
    }

    return batch
  }
}
