export class MemoryDatabaseClient {
  private readonly socketPath: string

  constructor(socketPath: string) {
    this.socketPath = socketPath
  }

  async storePayment(payment: ProcessedPayment): Promise<void> {
    fetch(`http://localhost/store`, {
      method: 'POST',
      body: JSON.stringify({ payment }),
      unix: this.socketPath,
      headers: {
        Connection: 'keep-alive'
      }
    }).catch(err => {
      console.error('Store payment error:', err)
    })
  }

  async getPaymentsByRange(from: string, to: string): Promise<string> {
    try {
      const res = await fetch(
        `http://localhost/getByRange?from=${from}&to=${to}`,
        {
          method: 'GET',
          unix: this.socketPath,
          headers: {
            Connection: 'keep-alive'
          }
        }
      )

      return await res.json()
    } catch (error) {
      console.error('Failed to get all payments via UDS client:', error)
      return ''
    }
  }
}
