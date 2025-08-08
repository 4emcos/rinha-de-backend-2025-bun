interface Payment {
  correlationId: string
  amount: string
}

interface DefaultPayment extends Payment {
  requestedAt: string
  requestedAtUnix: number
}

interface ProcessedPayment extends DefaultPayment {
  processed?: boolean
}
