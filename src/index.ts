import { request } from 'undici'
import { serve } from 'bun'
import { MemoryDatabaseClient } from './in-memory-database-client'
import { PaymentQueue } from './payment-queue'
import { CONFIG } from './configs'

let paymentTimeout = 0

const memoryDbClient = new MemoryDatabaseClient(Bun.env.WRITER_SOCKET_PATH)
const paymentQueue = new PaymentQueue()
const requestDefaultPayment = async (
  requestBody: DefaultPayment
): Promise<PaymentRequestStats> => {
  while (true) {
    const { statusCode } = await request(
      Bun.env.PAYMENT_PROCESSOR_DEFAULT + '/payments/',
      {
        method: 'POST',
        body: JSON.stringify(requestBody),
        headers: {
          'Content-Type': 'application/json'
        }
      }
    )

    if (statusCode === 200) {
      return {
        success: true,
        useFallback: false
      }
    }

    if (statusCode !== 200) {
      const { statusCode } = await request(
        Bun.env.PAYMENT_PROCESSOR_FALLBACK + '/payments/',
        {
          method: 'POST',
          body: JSON.stringify(requestBody),
          headers: {
            'Content-Type': 'application/json'
          }
        }
      )

      if (statusCode === 200) {
        return {
          success: true,
          useFallback: true
        }
      }
    }

    await Bun.sleep(1)
  }
}
const processBatch = async (batch: Payment[]): Promise<void> => {
  if (batch.length === 0) return

  const now = new Date()
  const timestamp = now.toISOString()
  const timestampUnix = now.getTime()

  const chunks: Payment[][] = []
  for (let i = 0; i < batch.length; i += CONFIG.CONCURRENT_REQUESTS) {
    chunks.push(batch.slice(i, i + CONFIG.CONCURRENT_REQUESTS))
  }
  const processingPromises = chunks.map(chunk =>
    Promise.allSettled(
      chunk.map(async payment => {
        const defaultPayment: DefaultPayment = {
          ...payment,
          requestedAt: timestamp,
          requestedAtUnix: timestampUnix
        }

        try {
          const requestPayment = await requestDefaultPayment(defaultPayment)
          if (requestPayment.success) {
            await memoryDbClient.storePayment({
              ...defaultPayment,
              processed: true,
              useFallback: requestPayment.useFallback
            })
          }
        } catch (error) {
          console.error('Payment processing error:', error)
        }
      })
    )
  )

  await Promise.allSettled(processingPromises)
}
const processPayments = async (): Promise<void> => {
  let consecutiveEmptyBatches = 0

  while (true) {
    try {
      const batch = await paymentQueue.dequeue(CONFIG.BATCH_SIZE)

      if (batch.length > 0) {
        consecutiveEmptyBatches = 0
        await processBatch(batch)
      } else {
        consecutiveEmptyBatches++
      }

      const queueLength = paymentQueue.length
      let waitTime = paymentTimeout || CONFIG.MIN_WAIT_TIME

      if (queueLength === 0) {
        if (consecutiveEmptyBatches > 5) {
          waitTime = CONFIG.MAX_WAIT_TIME
        } else {
          waitTime = CONFIG.MIN_WAIT_TIME * 2
        }
      } else if (queueLength > CONFIG.QUEUE_DRAIN_THRESHOLD) {
        waitTime = 0
      } else {
        waitTime = CONFIG.MIN_WAIT_TIME
      }

      if (waitTime > 0) {
        await Bun.sleep(waitTime)
      }
    } catch (error) {
      console.error('Payment processing error:', error)
      await Bun.sleep(CONFIG.MAX_WAIT_TIME)
    }
  }
}

async function handleRequest(request: Request): Promise<Response> {
  const { method } = request
  const url = new URL(request.url)
  const pathname = url.pathname

  if (method === 'GET' && pathname === '/payments-summary') {
    const fromStr = url.searchParams.get('from')
    const toStr = url.searchParams.get('to')

    return new Response(
      JSON.stringify(await memoryDbClient.getPaymentsByRange(fromStr, toStr)),
      {
        status: 200
      }
    )
  }

  if (method === 'POST' && pathname === '/payments') {
    const body = await request.json()
    paymentQueue.push(body)

    return new Response(null, {
      status: 201
    })
  }

  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' }
  })
}

const server = async (socketPath: string): Promise<void> => {
  try {
    processPayments().catch(err => {
      console.error('Payment processing thread error:', err)
    })

    const serverInstance = serve({
      fetch: handleRequest,
      development: false,
      unix: socketPath,
      reusePort: true
    })

    await Bun.spawn(['chmod', '666', socketPath]).exited
    console.log(`server running on unix socket: ${socketPath}`)
    const shutdown = async () => {
      console.log('Shutting down gracefully...')

      try {
        serverInstance.stop()

        console.log('Shutdown complete')
        process.exit(0)
      } catch (error) {
        console.error('Error during shutdown:', error)
        process.exit(1)
      }
    }

    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)
  } catch (err) {
    console.error('Server startup error:', err)
    process.exit(1)
  }
}

server(Bun.env.SERVICE_SOCKET_PATH!).catch(console.error)
