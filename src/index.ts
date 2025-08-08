import { request } from 'undici'
import { Mutex } from './mutex'
import { serve } from 'bun'
import { MemoryDatabaseClient } from './in-memory-database-client'

let paymentTimeout = 0
let globalErrorTime = 0

const memoryDbClient = new MemoryDatabaseClient(Bun.env.WRITER_SOCKET_PATH)
const healthCheckRoutine = async () => {
  try {
    const { statusCode, body } = await request(
      Bun.env.PAYMENT_PROCESSOR_DEFAULT + '/payments/service-health',
      { method: 'GET' }
    )
    if (statusCode === 200) {
      const health: any = await body.json()
      if (health.minResponseTime > 0) {
        paymentTimeout = health.minResponseTime
        console.log(`Updated paymentTimeout to ${paymentTimeout}ms`)
      }
      console.log('Health check: Healthy')
    } else {
      console.error(`Health check: Unhealthy (status ${statusCode})`)
      globalErrorTime = Date.now()
    }
  } catch (error) {
    console.error('Health check: Error', error)
    globalErrorTime = Date.now()
  }
}

const requestDefaultPayment = async (
  requestBody: DefaultPayment
): Promise<boolean> => {
  const { statusCode, body } = await request(
    Bun.env.PAYMENT_PROCESSOR_DEFAULT + '/payments/',
    {
      method: 'POST',
      body: JSON.stringify(requestBody),
      headers: {
        'Content-Type': 'application/json'
      }
    }
  )
  return statusCode === 200
}

const inMemoryPayments: Payment[] = []
const paymentsMutex = new Mutex()
const processPayments = async () => {
  const processBatch = async (batch: Payment[]) => {
    if (batch.length === 0) return []

    const now = new Date()
    const timestamp = now.toISOString()
    const timestampUnix = now.getTime()

    return Promise.all(
      batch.map(async payment => {
        try {
          const defaultPayment: DefaultPayment = {
            ...payment,
            requestedAt: timestamp,
            requestedAtUnix: timestampUnix
          }
          const haveSuccess = await requestDefaultPayment(defaultPayment)
          if (haveSuccess) {
            const processedPayment = {
              ...defaultPayment,
              processed: true
            }

            await memoryDbClient.storePayment(processedPayment)
            return null
          } else {
            await healthCheckRoutine()
            return payment
          }
        } catch (error) {
          globalErrorTime = Date.now()
          return payment
        }
      })
    )
  }

  while (true) {
    const batchSize = 100
    const paymentsToProcess = await paymentsMutex.withLock(async () => {
      if (inMemoryPayments.length === 0) {
        return []
      }

      return inMemoryPayments.splice(
        0,
        Math.min(batchSize, inMemoryPayments.length)
      )
    })

    if (paymentsToProcess.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 1))

      continue
    }

    const results = await processBatch(paymentsToProcess)

    const failedPayments = results.filter(p => p !== null)
    if (failedPayments.length > 0) {
      await paymentsMutex.withLock(async () => {
        inMemoryPayments.push(...failedPayments)
      })
    }

    const waitTime = paymentTimeout || 100
    if (waitTime > 0) {
      await new Promise(resolve => setTimeout(resolve, waitTime))
    }
  }
}

async function handleRequest(request: Request): Promise<Response> {
  const { method, url } = request

  if (method === 'GET' && url.includes('/payments-summary')) {
    const urlObj = new URL(url, 'http://localhost')

    const fromStr = urlObj.searchParams.get('from')
    const toStr = urlObj.searchParams.get('to')

    const fromUnix = fromStr ? new Date(fromStr).getTime() : 0
    const toUnix = toStr ? new Date(toStr).getTime() : Date.now()

    let totalRequests = 0
    let totalAmount = 0

    for (const p of await memoryDbClient.getAllPayments()) {
      if (
        p.requestedAtUnix >= fromUnix &&
        p.requestedAtUnix <= toUnix &&
        p.processed
      ) {
        totalRequests++
        totalAmount += parseFloat(p.amount)
      }
    }

    const response = {
      default: { totalRequests, totalAmount },
      fallback: { totalRequests: 0, totalAmount: 0 }
    }

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  if (method === 'POST' && url.includes('/payments')) {
    return request.json().then(async body => {
      await paymentsMutex.withLock(async () => {
        inMemoryPayments.push(body)
      })
      return new Response(null, { status: 201 })
    })
  }
  return new Response('Not found', { status: 404 })
}

const server = async (socketPath: string) => {
  try {
    processPayments().catch(err => {
      globalErrorTime = Date.now()
      console.error('Payment processing thread error:', err)
    })

    serve({
      fetch: handleRequest,
      development: false,
      unix: socketPath
    })

    await Bun.spawn(['chmod', '666', socketPath]).exited
    console.log(`running on unix socket: ${socketPath}`)
    await healthCheckRoutine()
  } catch (err) {
    globalErrorTime = Date.now()
    console.error('Server startup error:', err)
    process.exit(1)
  }
}

server(Bun.env.SERVICE_SOCKET_PATH).catch(console.log)
