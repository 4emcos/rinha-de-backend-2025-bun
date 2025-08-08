export class MemoryDatabaseClient {
  private readonly socketPath: string

  constructor(socketPath: string) {
    this.socketPath = socketPath
  }

  async storePayment(payment: ProcessedPayment): Promise<boolean> {
    try {
      const res = await fetch(`http://localhost/store`, {
        method: 'POST',
        body: JSON.stringify({ payment }),
        headers: { 'Content-Type': 'application/json' },
        unix: this.socketPath
      })
      const data = await res.json()
      return data.success
    } catch (error) {
      console.error('Failed to store payment via UDS client:', error)
      return false
    }
  }

  async getAllPayments(): Promise<ProcessedPayment[]> {
    try {
      const res = await fetch(`http://localhost/getAll`, {
        method: 'GET',
        unix: this.socketPath
      })

      const data = await res.json()
      return data.success ? data.payments : []
    } catch (error) {
      console.error('Failed to get all payments via UDS client:', error)
      return []
    }
  }
}
